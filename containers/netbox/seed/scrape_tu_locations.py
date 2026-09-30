#!/usr/bin/env python3
"""Download TU Darmstadt's building addresses into the NetBox seed files.

The university publishes its buildings on one overview page (key, designation,
street, postal code) and on one page per campus, which the keys link to. The
campus pages also list buildings the overview lacks, and what each building
houses. No other source offers this data (ADR 0031), so this script reads both
pages, in German and English, and writes

    tu-darmstadt/site-groups.json   campuses (S) and their sections (S1)
    tu-darmstadt/sites.json         one entry per building key (S1|01)

beside itself. The files are committed; `netbox-seed` loads them into NetBox
on every start. Run it again when the university changes its pages, and
review the diff before committing:

    python3 containers/netbox/seed/scrape_tu_locations.py

Standard library only, so it runs on any host with Python 3.11+.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path

BASE = "https://www.tu-darmstadt.de/universitaet/campus/"
OVERVIEW = BASE + "gebaeudeadressen_2/index.{lang}.jsp"
LANGS = ("de", "en")
OUT_DIR = Path(__file__).resolve().parent / "tu-darmstadt"

# A building key: campus letter, section digit, building number with an
# optional letter, e.g. S1|01, L2|10A.
KEY = r"[A-Z]\d+\|\d+[A-Z]?"
KEY_RE = re.compile(KEY)
# A line that starts a building: one key, or two joined by "+" (S1|17 + S1|18),
# then the designation.
BUILDING_RE = re.compile(rf"^({KEY}(?:\s*\+\s*{KEY})*)\s+(.+)$")
# Group headings: "S – Location Stadtmitte", "S1 – Section Stadtmitte Central".
GROUP_RE = re.compile(r"^([A-Z]\d*)\s+[–-]\s+(.+)$")
# The campus page heading: "Location Lichtwiese (L)".
CAMPUS_TITLE_RE = re.compile(r"^(.*?)\s*\((?:.*,\s*)?([A-Z])\)$")
POSTAL_RE = re.compile(r"^(\d{5})\s+(.+)$")
# Where a campus page's list of buildings ends.
STOP_HEADINGS = {"downloads", "how to get to the location", "anfahrt", "so erreichen sie uns", "kontakt", "contact"}

BLOCK_TAGS = {"p", "br", "div", "li", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "section", "button"}


def fetch(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "claude-feathers netbox seed scraper"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


class Lines(HTMLParser):
    """The text of <main> as lines, each tagged with the heading level it came
    from (0 for body text). Block elements and <br> end a line."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.lines: list[tuple[int, str]] = []
        self.links: list[str] = []
        self._in_main = 0
        self._skip = 0
        self._level = 0
        self._buf: list[str] = []
        self._title = False

    def _flush(self) -> None:
        text = clean("".join(self._buf))
        if text:
            self.lines.append((self._level, text))
        self._buf = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "main":
            self._in_main += 1
        if tag in ("script", "style"):
            self._skip += 1
        if tag == "h1" and not self._in_main:
            self._flush()
            self._level = 1
            self._title = True
        if not self._in_main and not self._title:
            return
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                self.links.append(href)
        if tag in BLOCK_TAGS:
            self._flush()
            if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
                self._level = int(tag[1])

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style"):
            self._skip -= 1
        if tag == "h1" and self._title:
            self._flush()
            self._level = 0
            self._title = False
            return
        if not self._in_main:
            return
        if tag in BLOCK_TAGS:
            self._flush()
            if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
                self._level = 0
        if tag == "main":
            self._in_main -= 1

    def handle_data(self, data: str) -> None:
        if (self._in_main or self._title) and not self._skip:
            self._buf.append(data)


class Table(HTMLParser):
    """The overview table: rows of cell texts, with the links in each row."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[tuple[list[str], list[str], bool]] = []
        self._cells: list[str] | None = None
        self._links: list[str] = []
        self._header = False
        self._cell: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = dict(attrs)
        if tag == "tr":
            self._cells, self._links, self._header = [], [], False
        elif tag in ("td", "th") and self._cells is not None:
            self._cell = []
            # A heading cell spanning the row names a campus or a section.
            if tag == "th" and a.get("colspan"):
                self._header = True
        elif tag == "a" and self._cells is not None and a.get("href"):
            self._links.append(a["href"] or "")
        elif tag == "br" and self._cell is not None:
            self._cell.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("td", "th") and self._cell is not None and self._cells is not None:
            lines = (clean(line) for line in "".join(self._cell).split("\n"))
            self._cells.append("\n".join(line for line in lines if line))
            self._cell = None
        elif tag == "tr" and self._cells is not None:
            self.rows.append((self._cells, self._links, self._header))
            self._cells = None

    def handle_data(self, data: str) -> None:
        if self._cell is not None:
            self._cell.append(data)


@dataclass
class Group:
    key: str
    name: dict[str, str] = field(default_factory=dict)
    notes: dict[str, list[str]] = field(default_factory=lambda: {lang: [] for lang in LANGS})


@dataclass
class Site:
    key: str
    name: dict[str, str] = field(default_factory=dict)
    street: str | None = None
    postal_code: str | None = None
    city: str | None = None
    # The address as the campus page writes it, where it adds to the
    # overview's (a second entrance, "patio", a delivery address).
    address_details: dict[str, list[str]] = field(default_factory=lambda: {lang: [] for lang in LANGS})
    occupants: dict[str, list[str]] = field(default_factory=lambda: {lang: [] for lang in LANGS})
    sources: set[str] = field(default_factory=set)


def group_key(key: str) -> str:
    return key.split("|")[0]


def slug(key: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", key.lower()).strip("-")


def looks_like_street(line: str) -> bool:
    return bool(re.search(r"\d", line)) or bool(re.search(r"(straße|strasse|weg|platz|allee)$", line, re.I))


def add_details(site: Site, lang: str, lines: list[str]) -> None:
    """Address lines beyond the street; "Delivery address:" joins the line
    after it."""
    pending = ""
    for line in lines:
        if line.endswith(":"):
            pending = line + " "
            continue
        line, pending = pending + line, ""
        if line != site.street and line not in site.address_details[lang]:
            site.address_details[lang].append(line)
    if pending:
        site.address_details[lang].append(pending.strip())


# Links to site plans and parking maps, not text about a building.
def is_download(line: str) -> bool:
    return bool(re.search(r"\((PDF|pdf)[- ](file|Datei)\)|opens in new tab|öffnet in neuem Tab", line))


def read_overview(groups: dict[str, Group], sites: dict[str, Site]) -> set[str]:
    """Keys, designations and postal addresses; returns the campus pages the
    keys link to, without language or anchor."""
    campus_pages: set[str] = set()
    for lang in LANGS:
        url = OVERVIEW.format(lang=lang)
        table = Table()
        table.feed(fetch(url))
        for cells, links, header in table.rows:
            for href in links:
                page = urllib.parse.urljoin(url, href).split("#")[0]
                if page.startswith(BASE) and "gebaeudeadressen" not in page:
                    campus_pages.add(re.sub(r"index\.\w\w\.jsp$", "index.{lang}.jsp", page))
            if header:
                m = GROUP_RE.match(cells[0]) if cells else None
                if m and m[1] and m[2]:
                    groups.setdefault(m[1], Group(m[1])).name.setdefault(lang, m[2])
                continue
            if len(cells) < 4:
                continue
            keys = KEY_RE.findall(cells[0])
            street_lines = cells[2].split("\n") if cells[2] else []
            street, details = (street_lines[0] if street_lines else None), street_lines[1:]
            for key in keys:
                site = sites.setdefault(key, Site(key))
                site.name.setdefault(lang, clean(cells[1]))
                site.street = site.street or street
                add_details(site, lang, details)
                m = POSTAL_RE.match(cells[3])
                if m:
                    site.postal_code, site.city = m[1], m[2]
                site.sources.add(url)
    return campus_pages


def read_campus_page(url: str, lang: str, groups: dict[str, Group], sites: dict[str, Site]) -> None:
    parser = Lines()
    parser.feed(fetch(url))
    current: list[Site] = []
    # What the next line is: a designation after a key standing alone (L3|02),
    # a street after a designation.
    expect: str | None = None
    delivery = False
    section: str | None = None
    for level, line in parser.lines:
        if level == 1:
            m = CAMPUS_TITLE_RE.match(line)
            if m:
                groups.setdefault(m[2], Group(m[2])).name.setdefault(lang, m[1])
            continue
        if line.lower() in STOP_HEADINGS or is_download(line):
            current, expect = [], None
            continue
        if level == 2:
            current, expect = [], None
        if level in (2, 3):
            # "Section S1 – Stadtmitte Central", "Abschnitt L1".
            m = re.match(r"^(?:Section|Abschnitt)\s+([A-Z]\d+)\b\s*[–-]?\s*(.*)$", line)
            if m:
                section = m[1]
                group = groups.setdefault(section, Group(section))
                if m[2]:
                    group.name.setdefault(lang, m[2])
                current, expect = [], None
                continue
        keys_only = re.fullmatch(rf"{KEY}(?:\s*\+\s*{KEY})*", line)
        m = BUILDING_RE.match(line)
        if keys_only or m:
            keys = KEY_RE.findall(line if keys_only else m[1])
            current = [sites.setdefault(key, Site(key)) for key in keys]
            for site in current:
                if m and not keys_only:
                    site.name.setdefault(lang, m[2])
                site.sources.add(url)
            expect = "name" if keys_only else "street"
            continue
        if KEY_RE.search(line):
            # A remark about several buildings ("Buildings L1|02 to L1|07 in
            # use by …") belongs to their section, not to the last building.
            target = group_key(KEY_RE.findall(line)[0])
            groups.setdefault(target, Group(target)).notes[lang].append(line)
            current, expect = [], None
            continue
        if not current:
            if section and level == 0:
                groups[section].notes[lang].append(line)
            continue
        if expect == "name":
            for site in current:
                site.name.setdefault(lang, line)
            expect = "street"
            continue
        if expect == "street" and looks_like_street(line):
            for site in current:
                if not site.street:
                    site.street = line
                add_details(site, lang, [line])
            expect = None
            continue
        expect = None
        if delivery or line.lower().startswith(("delivery address", "lieferadresse", "lieferanschrift")):
            # "Delivery address:" and the address may be split over two lines.
            for site in current:
                if delivery:
                    site.address_details[lang][-1] += " " + line
                else:
                    site.address_details[lang].append(line)
            delivery = line.endswith(":")
            continue
        for site in current:
            site.occupants[lang].append(line)


def fill_postal_codes(sites: dict[str, Site]) -> None:
    """A building only on a campus page gets the postal code of an overview
    building on the same street, if there is exactly one such code."""
    by_street: dict[str, set[tuple[str, str]]] = {}
    for site in sites.values():
        if site.street and site.postal_code and site.city:
            street = re.sub(r"\s*\d.*$", "", site.street)
            by_street.setdefault(street, set()).add((site.postal_code, site.city))
    for site in sites.values():
        if site.street and not site.postal_code:
            codes = by_street.get(re.sub(r"\s*\d.*$", "", site.street), set())
            if len(codes) == 1:
                site.postal_code, site.city = next(iter(codes))


def main() -> int:
    groups: dict[str, Group] = {}
    sites: dict[str, Site] = {}
    campus_pages = read_overview(groups, sites)
    if not sites:
        print("no buildings found on the overview page; has its layout changed?", file=sys.stderr)
        return 1
    for page in sorted(campus_pages):
        for lang in LANGS:
            read_campus_page(page.format(lang=lang), lang, groups, sites)
    fill_postal_codes(sites)
    for site in sites.values():
        for lang, details in site.address_details.items():
            # The overview's "Delivery address" without the address itself,
            # which the campus page gives.
            site.address_details[lang] = [d for d in details if not any(o != d and o.startswith(d) for o in details)]

    # Every section and campus a key implies exists, even if no page names it.
    for key in list(sites):
        section = group_key(key)
        groups.setdefault(section, Group(section))
        groups.setdefault(section[0], Group(section[0]))

    OUT_DIR.mkdir(exist_ok=True)
    group_list = [
        {
            "key": g.key,
            "slug": slug(g.key),
            "parent": None if len(g.key) == 1 else slug(g.key[0]),
            "name": {lang: g.name.get(lang) for lang in LANGS},
            "notes": g.notes,
        }
        for g in sorted(groups.values(), key=lambda g: (len(g.key) > 1, g.key))
    ]
    site_list = [
        {
            "key": s.key,
            "slug": slug(s.key),
            "group": slug(group_key(s.key)),
            "name": {lang: s.name.get(lang) for lang in LANGS},
            "address": {"street": s.street, "postalCode": s.postal_code, "city": s.city},
            "addressDetails": s.address_details,
            "occupants": s.occupants,
            "sources": sorted(u.replace(BASE, "") for u in s.sources),
        }
        for s in sorted(sites.values(), key=lambda s: (s.key.split("|")[0], s.key))
    ]
    for name, data in (("site-groups.json", group_list), ("sites.json", site_list)):
        (OUT_DIR / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    incomplete = [s["key"] for s in site_list if not all(s["address"].values())]
    print(f"{len(group_list)} site groups, {len(site_list)} sites written to {OUT_DIR}")
    if incomplete:
        print(f"without a complete address: {', '.join(incomplete)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
