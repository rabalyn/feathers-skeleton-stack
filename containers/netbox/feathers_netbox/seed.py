"""Seed NetBox from the committed JSON files (ADR 0031).

Run by netbox-setup after the migrations, at every start, through
`manage.py shell`. Everything is an upsert by slug or name, and nothing is
ever deleted, so NetBox ids stay stable: application records reference
sites by their NetBox id.

- Regions per city, site groups per campus (S) and section (S1), one site
  per building key (S1|01). Seeded objects carry the `seeded` tag; a seeded
  site the files no longer list is set to `retired`, not removed.
- The NetBox groups the IdP's groups map to (feathers_netbox.saml), with
  their object permissions.
- The api's user, permission to read the location models and to add
  locations (rooms) in seeded sites, nothing else, and its v2 token, from
  the key in NETBOX_TOKEN_KEY and the secret the agent rendered. A changed
  secret replaces the token.
"""

import json
import os
from pathlib import Path

from django.contrib.contenttypes.models import ContentType
from django.db import transaction
from django.utils.text import slugify

from dcim.models import Region, Site, SiteGroup
from extras.models import CustomField, Tag
from users.models import Group, ObjectPermission, Token, User

SEED_DIR = Path(os.environ.get('NETBOX_SEED_DIR', '/opt/feathers/seed/tu-darmstadt'))
API_USER = 'feathers-api'
TOKEN_KEY = os.environ['NETBOX_TOKEN_KEY']
TOKEN_SECRET_FILE = '/run/secrets/api_token'

LOCATION_MODELS = [('dcim', 'region'), ('dcim', 'sitegroup'), ('dcim', 'site'), ('dcim', 'location')]

# NetBox groups with what they may do; the IdP's groups of the same name
# make people members (ADR 0031).
GROUPS = {
    'netbox-readers': {
        'description': 'Read regions, site groups, sites and locations',
        'actions': ['view'],
        'models': LOCATION_MODELS,
    },
    'netbox-editors': {
        'description': 'Maintain locations (rooms) inside the seeded sites',
        'actions': ['view', 'add', 'change', 'delete'],
        'models': [('dcim', 'location')],
    },
}

CUSTOM_FIELDS = {
    'name_en': ('text', 'Name (English)'),
    'occupants_de': ('longtext', 'Occupants (German)'),
    'occupants_en': ('longtext', 'Occupants (English)'),
}


def content_types(models):
    return [ContentType.objects.get(app_label=app, model=model) for app, model in models]


def upsert(model, lookup, **values):
    obj, created = model.objects.get_or_create(**lookup, defaults=values)
    if not created:
        changed = [k for k, v in values.items() if getattr(obj, k) != v]
        if changed:
            for k in changed:
                setattr(obj, k, values[k])
            obj.full_clean()
            obj.save()
    return obj


def permission(name, description, actions, models, constraints=None):
    perm = upsert(ObjectPermission, {'name': name}, description=description, enabled=True,
                  actions=actions, constraints=constraints)
    perm.object_types.set(content_types(models))
    return perm


def seed_locations(tag):
    groups = json.loads((SEED_DIR / 'site-groups.json').read_text(encoding='utf-8'))
    sites = json.loads((SEED_DIR / 'sites.json').read_text(encoding='utf-8'))

    site_type = ContentType.objects.get(app_label='dcim', model='site')
    for name, (kind, label) in CUSTOM_FIELDS.items():
        field = upsert(CustomField, {'name': name}, type=kind, label=label, group_name='TU Darmstadt')
        field.object_types.add(site_type)

    by_slug = {}
    # Campuses first: a section names its campus as parent.
    for g in sorted(groups, key=lambda g: g['parent'] is not None):
        name = f"{g['key']} – {g['name']['de'] or g['name']['en'] or g['key']}"
        obj = upsert(SiteGroup, {'slug': g['slug']}, name=name[:100],
                     parent=by_slug.get(g['parent']), description=(g['name']['en'] or '')[:200])
        obj.tags.add(tag)
        by_slug[g['slug']] = obj

    regions = {}
    seen = set()
    for s in sites:
        address = s['address']
        city = address['city']
        if city and city not in regions:
            regions[city] = upsert(Region, {'slug': slugify(city)}, name=city)
            regions[city].tags.add(tag)
        name_de = s['name']['de'] or s['name']['en'] or ''
        street_line = address['street'] or ''
        city_line = ' '.join(p for p in (address['postalCode'], city) if p)
        details = s['addressDetails']['de'] or s['addressDetails']['en']
        delivery = next((d for d in details if ':' in d and d.lower().startswith(('lieferanschrift', 'delivery'))), '')
        site = upsert(
            Site, {'slug': s['slug']},
            name=f"{s['key']} {name_de}".strip()[:100],
            status='active',
            region=regions.get(city),
            group=by_slug[s['group']],
            facility=s['key'],
            time_zone='Europe/Berlin',
            physical_address='\n'.join(p for p in (street_line, city_line) if p),
            shipping_address=delivery.split(':', 1)[1].strip() if delivery else '',
            description=(s['name']['en'] or '')[:200],
            comments='\n'.join(f'- {d}' for d in details if d != delivery),
            custom_field_data={
                'name_en': s['name']['en'] or '',
                'occupants_de': '\n'.join(s['occupants']['de']),
                'occupants_en': '\n'.join(s['occupants']['en']),
            },
        )
        site.tags.add(tag)
        seen.add(site.pk)

    retired = Site.objects.filter(tags=tag).exclude(pk__in=seen).exclude(status='retired')
    for site in retired:
        site.status = 'retired'
        site.save()
    print(f'netbox-seed: {len(groups)} site groups, {len(sites)} sites, {len(regions)} regions; '
          f'{len(retired)} retired')


def seed_groups():
    for name, spec in GROUPS.items():
        group = upsert(Group, {'name': name}, description=spec['description'])
        perm = permission(f'{name}: locations', spec['description'], spec['actions'], spec['models'])
        perm.groups.set([group])


def seed_api_user():
    user, _ = User.objects.get_or_create(username=API_USER)
    if user.has_usable_password():
        user.set_unusable_password()
        user.save()
    read = permission(f'{API_USER}: read locations', 'The application reads locations (ADR 0031)',
                      ['view'], LOCATION_MODELS)
    add = permission(f'{API_USER}: add rooms', 'The application adds rooms to seeded sites (ADR 0031)',
                     ['add'], [('dcim', 'location')], constraints={'site__tags__slug': 'seeded'})
    for perm in (read, add):
        perm.users.set([user])

    secret = Path(TOKEN_SECRET_FILE).read_text(encoding='utf-8').strip()
    token = Token.objects.filter(key=TOKEN_KEY).first()
    if token and (token.user_id != user.pk or not token.validate(secret) or not token.write_enabled):
        token.delete()
        token = None
    if token is None:
        # Writes as far as the user's permissions go: adding rooms.
        token = Token(version=2, user=user, key=TOKEN_KEY, write_enabled=True,
                      description='claude-feathers api: reads, adds rooms (ADR 0031)', token=secret)
        token.full_clean()
        token.save()
        print('netbox-seed: issued the api token')


with transaction.atomic():
    tag = upsert(Tag, {'slug': 'seeded'}, name='seeded', description='Loaded from the seed files (ADR 0031)')
    seed_locations(tag)
    seed_groups()
    seed_api_user()
