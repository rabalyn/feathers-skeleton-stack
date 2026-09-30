"""NetBox rights from the IdP's groups (ADR 0031).

The last step of the social-auth pipeline, at every SAML login: the groups
the IdP sends in NETBOX_SAML_GROUPS_ATTRIBUTE decide

- whether the person is a NetBox superuser: a member of any group in
  NETBOX_SAML_SUPERUSER_GROUPS, and
- which NetBox groups they belong to: every NetBox group whose name the IdP
  sent. Groups the IdP did not send are left, so a right removed in the
  directory is removed in NetBox at the next login.

Groups that exist only in the IdP are ignored; what a NetBox group may do is
set in NetBox (netbox-setup seeds the two it ships, ADR 0031).
"""

from os import environ

from users.models import Group


def _names(value: str) -> set[str]:
    return {name for name in value.split() if name}


def sync_groups(backend, user=None, response=None, *args, **kwargs):
    if user is None or backend.name != 'saml':
        return
    attributes = (response or {}).get('attributes', {})
    sent = set(attributes.get(environ.get('NETBOX_SAML_GROUPS_ATTRIBUTE', 'groups'), []))
    user.is_superuser = bool(sent & _names(environ.get('NETBOX_SAML_SUPERUSER_GROUPS', '')))
    user.save(update_fields=['is_superuser'])
    user.groups.set(Group.objects.filter(name__in=sent))
