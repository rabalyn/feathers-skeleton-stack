# claude-feathers settings for NetBox (ADR 0031), loaded by the image after
# its own configuration.py, whose values it overrides or completes. Values
# that differ between environments come from the environment; secrets from
# the files the netbox-agent renders into /run/secrets (ADR 0023).

from os import environ

from netbox.configuration.configuration import DATABASES, REDIS


def _secret(name: str) -> str:
    with open(f'/run/secrets/{name}', encoding='utf-8') as f:
        return f.read().strip()


def _pem_body(pem: str) -> str:
    return ''.join(line for line in pem.splitlines() if not line.startswith('-----'))


PUBLIC_ORIGIN = environ['NETBOX_PUBLIC_ORIGIN']

# PostgreSQL through PgBouncer in transaction mode (ADR 0004), verified TLS.
# Server-side cursors do not survive transaction pooling.
DATABASES['default']['OPTIONS'] = {'sslmode': 'verify-full', 'sslrootcert': '/trust/ca.crt'}
DATABASES['default']['DISABLE_SERVER_SIDE_CURSORS'] = True

# Valkey over verified TLS, as NetBox's own user (ADR 0010).
for _redis in REDIS.values():
    _redis['SSL'] = True
    _redis['CA_CERT_PATH'] = '/trust/ca.crt'

# Self-contained (ADR 0001): nothing reaches out of the stack.
ISOLATED_DEPLOYMENT = True
CENSUS_REPORTING_ENABLED = False
COPILOT_ENABLED = False
RELEASE_CHECK_URL = None

# Behind Nginx on HTTPS only (ADR 0016).
ALLOWED_HOSTS = [environ['NETBOX_HOST'], 'netbox', 'localhost']
CSRF_TRUSTED_ORIGINS = [PUBLIC_ORIGIN]
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
LOGIN_REQUIRED = True
TIME_ZONE = 'Europe/Berlin'

# SAML2 through the same IdP as the application (ADR 0008, 0031). People are
# created at their first login; the IdP's group attribute decides their
# NetBox groups and whether they are superusers (feathers_netbox.saml).
REMOTE_AUTH_BACKEND = 'social_core.backends.saml.SAMLAuth'
SOCIAL_AUTH_SAML_SP_ENTITY_ID = f'{PUBLIC_ORIGIN}/oauth/metadata/saml/'
SOCIAL_AUTH_SAML_SP_PUBLIC_CERT = _pem_body(_secret('saml_sp_cert'))
SOCIAL_AUTH_SAML_SP_PRIVATE_KEY = _pem_body(_secret('saml_sp_key'))
SOCIAL_AUTH_SAML_ORG_INFO = {
    'en-US': {'name': 'claude-feathers', 'displayname': 'NetBox', 'url': PUBLIC_ORIGIN},
}
SOCIAL_AUTH_SAML_TECHNICAL_CONTACT = {'givenName': 'Operators', 'emailAddress': environ['NETBOX_CONTACT_EMAIL']}
SOCIAL_AUTH_SAML_SUPPORT_CONTACT = SOCIAL_AUTH_SAML_TECHNICAL_CONTACT
SOCIAL_AUTH_SAML_SECURITY_CONFIG = {
    'authnRequestsSigned': True,
    'wantMessagesSigned': False,
    'wantAssertionsSigned': True,
    'wantAssertionsEncrypted': True,
    'requestedAuthnContext': False,
    # IdPs may send a multi-valued attribute as several elements of one name
    # (Keycloak's role list does); the values are merged.
    'allowRepeatAttributeName': True,
    'signatureAlgorithm': 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    'digestAlgorithm': 'http://www.w3.org/2001/04/xmlenc#sha256',
}
SOCIAL_AUTH_SAML_ENABLED_IDPS = {
    'idp': {
        'entity_id': environ['SAML_IDP_ENTITY_ID'],
        'url': environ['SAML_IDP_SSO_URL'],
        'x509cert': _pem_body(_secret('saml_idp_cert')),
        # The TU-ID is the permanent identifier and the username (ADR 0009).
        'attr_user_permanent_id': 'cn',
        'attr_username': 'cn',
        'attr_email': 'mail',
        'attr_first_name': 'givenName',
        'attr_last_name': 'sn',
    },
}
SOCIAL_AUTH_BACKEND_ATTRS = {'saml': ('TU-ID', None)}
SOCIAL_AUTH_PIPELINE = (
    'social_core.pipeline.social_auth.social_details',
    'social_core.pipeline.social_auth.social_uid',
    'social_core.pipeline.social_auth.social_user',
    'social_core.pipeline.user.get_username',
    'social_core.pipeline.user.create_user',
    'social_core.pipeline.social_auth.associate_user',
    'social_core.pipeline.social_auth.load_extra_data',
    'social_core.pipeline.user.user_details',
    'feathers_netbox.saml.sync_groups',
)
