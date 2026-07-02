# DNS bootstrap (mgmt account 438465156498)

Creates `Route53RecordWriter`, assumed by the app deploy accounts to manage
records in the `christophercorbin.cloud` zone. Apply once with the mgmt profile:

    aws sso login --sso-session personal
    tofu -chdir=infra/dns-bootstrap init
    tofu -chdir=infra/dns-bootstrap apply   # profile: personal-christopher-corbin

Shared infra; lives here for convenience. State is local to this directory.
