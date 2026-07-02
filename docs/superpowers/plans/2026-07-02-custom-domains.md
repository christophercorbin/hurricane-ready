# Custom Domains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve math-mentor at `mathmentor.christophercorbin.cloud` and Bim Weather at `bimweather.christophercorbin.cloud` over HTTPS, with ACM certs DNS-validated automatically through cross-account Route53.

**Architecture:** A single least-privilege IAM role in the DNS/management account (…6498) is assumed by each app's Terraform via an aliased `aws.dns` provider. Each app then creates its own ACM cert (us-east-1), writes the DNS validation records and the CloudFront alias record into the authoritative `christophercorbin.cloud` zone, and attaches the validated cert to its CloudFront distribution. 100% AWS — no Cloudflare.

**Tech Stack:** OpenTofu/Terraform (`hashicorp/aws ~> 5.0`), AWS Route53, ACM, CloudFront, IAM. AWS access via SSO profiles.

## Global Constraints

- ACM certificates for CloudFront MUST be in **us-east-1**. Both apps default `region = us-east-1`, so the default provider is us-east-1 — no separate ACM provider alias is required.
- Authoritative hosted zone: **`Z08882413R82BOPJVWS7Z`** (`christophercorbin.cloud`) in account **438465156498** (`personal-christopher-corbin`, the …6498 mgmt account). This is the only zone whose nameservers are publicly delegated.
- Cross-account DNS role ARN: **`arn:aws:iam::438465156498:role/Route53RecordWriter`**.
- Assume-role external id (defense-in-depth, not a secret): **`corbin-dns-delegation`**.
- Subdomains: **`mathmentor.christophercorbin.cloud`** (deploy account 590716168923, `personal-eportfolio-prod`), **`bimweather.christophercorbin.cloud`** (deploy account 385467776718, `personal-sandbox`).
- CloudFront alias records use the fixed CloudFront hosted-zone id via `<distribution>.hosted_zone_id` and `<distribution>.domain_name`, both `A` and `AAAA`.
- Every `apply` is a real AWS mutation. `personal-sandbox` is low-risk. **`personal-eportfolio-prod` is a production account — confirm the plan output before applying.**
- Always run `tofu fmt` + `tofu validate` before committing infra. Use `tofu` (fall back to `terraform` if `tofu` is absent).
- All AWS commands pass `--profile <name>` explicitly.

---

### Task 1: Bootstrap the cross-account Route53 role (mgmt account …6498)

**Files:**
- Create: `hurricane-ready/infra/dns-bootstrap/main.tf`
- Create: `hurricane-ready/infra/dns-bootstrap/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: IAM role `arn:aws:iam::438465156498:role/Route53RecordWriter`, assumable by accounts `385467776718` and `590716168923` with external id `corbin-dns-delegation`, scoped to zone `Z08882413R82BOPJVWS7Z`. Output `role_arn`.

- [ ] **Step 1: Write the bootstrap config**

Create `hurricane-ready/infra/dns-bootstrap/main.tf`:

```hcl
# One-time bootstrap: a least-privilege role in the DNS/management account
# (438465156498) that the app deploy accounts assume to manage records in the
# christophercorbin.cloud hosted zone. Apply once with the mgmt profile:
#   tofu -chdir=infra/dns-bootstrap init
#   tofu -chdir=infra/dns-bootstrap apply   # AWS_PROFILE/-var creds: personal-christopher-corbin
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

variable "zone_id" {
  type    = string
  default = "Z08882413R82BOPJVWS7Z"
}

variable "deploy_account_ids" {
  type    = list(string)
  default = ["385467776718", "590716168923"] # sandbox (Bim Weather), eportfolio-prod (math-mentor)
}

variable "external_id" {
  type    = string
  default = "corbin-dns-delegation"
}

data "aws_iam_policy_document" "trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = [for id in var.deploy_account_ids : "arn:aws:iam::${id}:root"]
    }
    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = [var.external_id]
    }
  }
}

data "aws_iam_policy_document" "records" {
  statement {
    sid       = "WriteRecordsInZone"
    effect    = "Allow"
    actions   = ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets"]
    resources = ["arn:aws:route53:::hostedzone/${var.zone_id}"]
  }
  statement {
    sid       = "TrackChanges"
    effect    = "Allow"
    actions   = ["route53:GetChange"]
    resources = ["arn:aws:route53:::change/*"]
  }
  statement {
    sid       = "FindZone"
    effect    = "Allow"
    actions   = ["route53:ListHostedZonesByName", "route53:ListHostedZones"]
    resources = ["*"]
  }
}

resource "aws_iam_role" "record_writer" {
  name               = "Route53RecordWriter"
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

resource "aws_iam_role_policy" "record_writer" {
  name   = "route53-record-writer"
  role   = aws_iam_role.record_writer.id
  policy = data.aws_iam_policy_document.records.json
}

output "role_arn" {
  value = aws_iam_role.record_writer.arn
}
```

Create `hurricane-ready/infra/dns-bootstrap/README.md`:

```markdown
# DNS bootstrap (mgmt account 438465156498)

Creates `Route53RecordWriter`, assumed by the app deploy accounts to manage
records in the `christophercorbin.cloud` zone. Apply once with the mgmt profile:

    aws sso login --sso-session personal
    tofu -chdir=infra/dns-bootstrap init
    tofu -chdir=infra/dns-bootstrap apply   # profile: personal-christopher-corbin

Shared infra; lives here for convenience. State is local to this directory.
```

- [ ] **Step 2: Init + validate**

Run: `AWS_PROFILE=personal-christopher-corbin tofu -chdir=infra/dns-bootstrap init && tofu -chdir=infra/dns-bootstrap validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Plan (review)**

Run: `AWS_PROFILE=personal-christopher-corbin tofu -chdir=infra/dns-bootstrap plan`
Expected: creates `aws_iam_role.record_writer` + `aws_iam_role_policy.record_writer` (2 to add, 0 change, 0 destroy).

- [ ] **Step 4: Apply**

Run: `AWS_PROFILE=personal-christopher-corbin tofu -chdir=infra/dns-bootstrap apply`
Expected: `Apply complete!` and an `role_arn` output equal to `arn:aws:iam::438465156498:role/Route53RecordWriter`.

- [ ] **Step 5: Verify the role exists**

Run: `aws iam get-role --role-name Route53RecordWriter --profile personal-christopher-corbin --query 'Role.Arn' --output text`
Expected: `arn:aws:iam::438465156498:role/Route53RecordWriter`

- [ ] **Step 6: Commit**

```bash
cd hurricane-ready
git add infra/dns-bootstrap/main.tf infra/dns-bootstrap/README.md
git commit -m "infra(dns): bootstrap cross-account Route53RecordWriter role"
```

---

### Task 2: Bim Weather — add DNS provider, cert, and domain wiring (config only)

**Files:**
- Modify: `hurricane-ready/infra/main.tf` (add `aws.dns` aliased provider near the existing `provider "aws"`)
- Modify: `hurricane-ready/infra/cloudfront.tf` (replace the `aliases`/`acm_certificate_arn` input vars + `use_custom_domain` local; update `aliases` and `viewer_certificate` to reference the managed cert)
- Create: `hurricane-ready/infra/domain.tf` (domain vars, ACM cert, validation records, alias records)

**Interfaces:**
- Consumes: `arn:aws:iam::438465156498:role/Route53RecordWriter` (Task 1); existing `aws_cloudfront_distribution.app`.
- Produces: `local.use_custom_domain`; `aws_acm_certificate_validation.app[0].certificate_arn`; alias records for `bimweather.christophercorbin.cloud`.

- [ ] **Step 1: Add the `aws.dns` provider**

In `hurricane-ready/infra/main.tf`, immediately after the existing `provider "aws" { region = var.region }` block, add:

```hcl
# Cross-account provider: assumes the Route53RecordWriter role in the DNS
# management account (438465156498) to write records in christophercorbin.cloud.
provider "aws" {
  alias  = "dns"
  region = "us-east-1"
  assume_role {
    role_arn    = var.dns_role_arn
    external_id = var.dns_external_id
  }
}
```

- [ ] **Step 2: Replace the custom-domain input vars/local in `cloudfront.tf`**

In `hurricane-ready/infra/cloudfront.tf`, delete the block from `variable "aliases" {` through the closing `}` of `locals { use_custom_domain = ... }` (lines that currently define `variable "aliases"`, `variable "acm_certificate_arn"`, and the `locals` with `use_custom_domain`). Replace the leading comment (`# ---------- Custom domain + TLS ...`) and those blocks with:

```hcl
# ---------- Custom domain + TLS ----------
# Set var.domain to enable the custom domain (cert + DNS are fully managed in
# domain.tf via the cross-account aws.dns provider). Empty string => stay on the
# default *.cloudfront.net cert.
locals {
  use_custom_domain = var.domain != ""
}
```

- [ ] **Step 3: Point the distribution at the managed cert**

In `hurricane-ready/infra/cloudfront.tf`, change the `aliases` line (currently `aliases = var.aliases`) to:

```hcl
  aliases = local.use_custom_domain ? [var.domain] : []
```

And change the `viewer_certificate` block's `acm_certificate_arn` line (currently `acm_certificate_arn = local.use_custom_domain ? var.acm_certificate_arn : null`) to:

```hcl
    acm_certificate_arn = local.use_custom_domain ? aws_acm_certificate_validation.app[0].certificate_arn : null
```

- [ ] **Step 4: Create `domain.tf`**

Create `hurricane-ready/infra/domain.tf`:

```hcl
# Custom-domain resources for Bim Weather. All DNS records land in the
# authoritative christophercorbin.cloud zone (mgmt account) via aws.dns.

variable "domain" {
  description = "Custom subdomain for the dashboard. Empty disables the custom domain."
  type        = string
  default     = "bimweather.christophercorbin.cloud"
}

variable "dns_role_arn" {
  description = "ARN of the Route53RecordWriter role in the DNS management account."
  type        = string
  default     = "arn:aws:iam::438465156498:role/Route53RecordWriter"
}

variable "dns_zone_id" {
  description = "Hosted zone id for christophercorbin.cloud (authoritative, mgmt account)."
  type        = string
  default     = "Z08882413R82BOPJVWS7Z"
}

variable "dns_external_id" {
  description = "External id required to assume the Route53RecordWriter role."
  type        = string
  default     = "corbin-dns-delegation"
}

# us-east-1 cert for CloudFront (default provider is us-east-1).
resource "aws_acm_certificate" "app" {
  count             = local.use_custom_domain ? 1 : 0
  domain_name       = var.domain
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

# DNS validation records, written cross-account into the authoritative zone.
resource "aws_route53_record" "acm_validation" {
  for_each = local.use_custom_domain ? {
    for o in aws_acm_certificate.app[0].domain_validation_options : o.domain_name => {
      name   = o.resource_record_name
      type   = o.resource_record_type
      record = o.resource_record_value
    }
  } : {}

  provider        = aws.dns
  zone_id         = var.dns_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "app" {
  count                   = local.use_custom_domain ? 1 : 0
  certificate_arn         = aws_acm_certificate.app[0].arn
  validation_record_fqdns = [for r in aws_route53_record.acm_validation : r.fqdn]
}

# Public alias records -> CloudFront.
resource "aws_route53_record" "alias_a" {
  count    = local.use_custom_domain ? 1 : 0
  provider = aws.dns
  zone_id  = var.dns_zone_id
  name     = var.domain
  type     = "A"
  alias {
    name                   = aws_cloudfront_distribution.app.domain_name
    zone_id                = aws_cloudfront_distribution.app.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "alias_aaaa" {
  count    = local.use_custom_domain ? 1 : 0
  provider = aws.dns
  zone_id  = var.dns_zone_id
  name     = var.domain
  type     = "AAAA"
  alias {
    name                   = aws_cloudfront_distribution.app.domain_name
    zone_id                = aws_cloudfront_distribution.app.hosted_zone_id
    evaluate_target_health = false
  }
}

output "custom_domain_url" {
  value = local.use_custom_domain ? "https://${var.domain}" : null
}
```

- [ ] **Step 5: fmt + validate**

Run: `cd hurricane-ready && tofu -chdir=infra fmt && tofu -chdir=infra init -backend=false && tofu -chdir=infra validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 6: Commit**

```bash
cd hurricane-ready
git add infra/main.tf infra/cloudfront.tf infra/domain.tf
git commit -m "infra(bim): manage bimweather.christophercorbin.cloud cert + DNS via cross-account Route53"
```

---

### Task 3: Bim Weather — apply and verify (account: personal-sandbox)

**Files:** none (uses committed config from Task 2).

**Interfaces:**
- Consumes: Task 1 role, Task 2 config.
- Produces: a live `https://bimweather.christophercorbin.cloud`.

- [ ] **Step 1: Plan (review the real change set)**

Run: `AWS_PROFILE=personal-sandbox tofu -chdir=hurricane-ready/infra init && AWS_PROFILE=personal-sandbox tofu -chdir=hurricane-ready/infra plan`
Expected: adds `aws_acm_certificate.app[0]`, `aws_route53_record.acm_validation[...]`, `aws_acm_certificate_validation.app[0]`, `aws_route53_record.alias_a[0]`, `aws_route53_record.alias_aaaa[0]`, and an in-place update to `aws_cloudfront_distribution.app` (aliases + viewer_certificate). No destroys of the distribution.

- [ ] **Step 2: Apply**

Run: `AWS_PROFILE=personal-sandbox tofu -chdir=hurricane-ready/infra apply`
Expected: `Apply complete!`; cert validation completes (may take a few minutes for DNS propagation); `custom_domain_url = "https://bimweather.christophercorbin.cloud"`.

- [ ] **Step 3: Verify cert is ISSUED**

Run: `aws acm list-certificates --profile personal-sandbox --region us-east-1 --query "CertificateSummaryList[?DomainName=='bimweather.christophercorbin.cloud'].Status" --output text`
Expected: `ISSUED`

- [ ] **Step 4: Verify DNS + HTTPS**

Run: `dig +short bimweather.christophercorbin.cloud` (expected: resolves to CloudFront IPs / the distribution) then `curl -sS -o /dev/null -w "%{http_code} %{ssl_verify_result}\n" https://bimweather.christophercorbin.cloud/healthz`
Expected: `200 0` (200 status, TLS verify result 0 = OK). If DNS hasn't propagated yet, retry after a minute.

- [ ] **Step 5: Commit (record the verified state)**

No file changes; if `terraform.tfstate` is tracked in this repo, commit it:

```bash
cd hurricane-ready
git add infra/terraform.tfstate infra/terraform.tfstate.backup 2>/dev/null || true
git commit -m "infra(bim): apply custom domain (state)" || echo "nothing to commit"
```

---

### Task 4: math-mentor — replace Cloudflare two-step with Route53 automation (config only)

**Files:**
- Modify: `math-mentor/infra/main.tf` (add `aws.dns` provider; drop `domain_ready` from `local.use_custom_domain`; add validation + alias records; update the validation resource; remove the Cloudflare comment)
- Modify: `math-mentor/infra/variables.tf` (remove `variable "domain_ready"`; add `dns_role_arn`, `dns_zone_id`, `dns_external_id`)

**Interfaces:**
- Consumes: Task 1 role; existing `aws_acm_certificate.custom`, `aws_acm_certificate_validation.custom`, `aws_cloudfront_distribution.web`, `var.domain_name` (default `mathmentor.christophercorbin.cloud`).
- Produces: automated validation + alias records for `mathmentor.christophercorbin.cloud`.

- [ ] **Step 1: Add the `aws.dns` provider**

In `math-mentor/infra/main.tf`, immediately after `provider "aws" { region = var.region }`, add:

```hcl
# Cross-account provider: assumes Route53RecordWriter in the DNS management
# account (438465156498) to write records in christophercorbin.cloud.
provider "aws" {
  alias  = "dns"
  region = "us-east-1"
  assume_role {
    role_arn    = var.dns_role_arn
    external_id = var.dns_external_id
  }
}
```

- [ ] **Step 2: Drop `domain_ready` from the local**

In `math-mentor/infra/main.tf`, change the `use_custom_domain` local (currently `use_custom_domain = var.domain_ready && var.domain_name != ""`) to:

```hcl
  use_custom_domain = var.domain_name != ""
```

- [ ] **Step 3: Replace the Cloudflare comment + validation resource with Route53-managed records**

In `math-mentor/infra/main.tf`, replace the comment line `# ---------- Custom domain (DNS lives in Cloudflare — see variables.tf) ----------` with `# ---------- Custom domain (DNS managed in Route53 via aws.dns) ----------`.

Then replace the entire `aws_acm_certificate_validation "custom"` resource (and its preceding Cloudflare comment) with:

```hcl
# DNS validation records written cross-account into the authoritative zone.
resource "aws_route53_record" "acm_validation" {
  for_each = local.use_custom_domain ? {
    for o in aws_acm_certificate.custom[0].domain_validation_options : o.domain_name => {
      name   = o.resource_record_name
      type   = o.resource_record_type
      record = o.resource_record_value
    }
  } : {}

  provider        = aws.dns
  zone_id         = var.dns_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "custom" {
  count                   = local.use_custom_domain ? 1 : 0
  certificate_arn         = aws_acm_certificate.custom[0].arn
  validation_record_fqdns = [for r in aws_route53_record.acm_validation : r.fqdn]
}

# Public alias records -> CloudFront.
resource "aws_route53_record" "alias_a" {
  count    = local.use_custom_domain ? 1 : 0
  provider = aws.dns
  zone_id  = var.dns_zone_id
  name     = var.domain_name
  type     = "A"
  alias {
    name                   = aws_cloudfront_distribution.web.domain_name
    zone_id                = aws_cloudfront_distribution.web.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "alias_aaaa" {
  count    = local.use_custom_domain ? 1 : 0
  provider = aws.dns
  zone_id  = var.dns_zone_id
  name     = var.domain_name
  type     = "AAAA"
  alias {
    name                   = aws_cloudfront_distribution.web.domain_name
    zone_id                = aws_cloudfront_distribution.web.hosted_zone_id
    evaluate_target_health = false
  }
}
```

- [ ] **Step 4: Update variables**

In `math-mentor/infra/variables.tf`, delete the entire `variable "domain_ready" { ... }` block, and add:

```hcl
variable "dns_role_arn" {
  description = "ARN of the Route53RecordWriter role in the DNS management account."
  type        = string
  default     = "arn:aws:iam::438465156498:role/Route53RecordWriter"
}

variable "dns_zone_id" {
  description = "Hosted zone id for christophercorbin.cloud (authoritative, mgmt account)."
  type        = string
  default     = "Z08882413R82BOPJVWS7Z"
}

variable "dns_external_id" {
  description = "External id required to assume the Route53RecordWriter role."
  type        = string
  default     = "corbin-dns-delegation"
}
```

- [ ] **Step 5: fmt + validate**

Run: `cd math-mentor && tofu -chdir=infra fmt && tofu -chdir=infra init -backend=false && tofu -chdir=infra validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 6: Commit**

```bash
cd math-mentor
git add infra/main.tf infra/variables.tf
git commit -m "infra: manage custom domain cert + DNS via cross-account Route53 (drop Cloudflare two-step)"
```

---

### Task 5: math-mentor — apply and verify (account: personal-eportfolio-prod — PRODUCTION)

**Files:** none.

**Interfaces:**
- Consumes: Task 1 role, Task 4 config.
- Produces: a live `https://mathmentor.christophercorbin.cloud`.

- [ ] **Step 1: Plan (review carefully — this is production)**

Run: `AWS_PROFILE=personal-eportfolio-prod tofu -chdir=math-mentor/infra init && AWS_PROFILE=personal-eportfolio-prod tofu -chdir=math-mentor/infra plan`
Expected: adds `aws_route53_record.acm_validation[...]`, `aws_acm_certificate_validation.custom[0]`, `aws_route53_record.alias_a[0]`, `aws_route53_record.alias_aaaa[0]`; in-place update to `aws_cloudfront_distribution.web` (aliases + viewer_certificate) and `aws_s3_object` head assets whose content references `site_origin` flipping to the custom domain. **No destroys.** Stop and get explicit confirmation before applying.

- [ ] **Step 2: Apply (after confirmation)**

Run: `AWS_PROFILE=personal-eportfolio-prod tofu -chdir=math-mentor/infra apply`
Expected: `Apply complete!`; cert validates within a few minutes.

- [ ] **Step 3: Verify cert ISSUED**

Run: `aws acm list-certificates --profile personal-eportfolio-prod --region us-east-1 --query "CertificateSummaryList[?DomainName=='mathmentor.christophercorbin.cloud'].Status" --output text`
Expected: `ISSUED`

- [ ] **Step 4: Verify DNS + HTTPS + canonical**

Run: `dig +short mathmentor.christophercorbin.cloud` then `curl -sS -o /dev/null -w "%{http_code} %{ssl_verify_result}\n" https://mathmentor.christophercorbin.cloud/` then `curl -sS https://mathmentor.christophercorbin.cloud/ | grep -o 'rel="canonical" href="https://mathmentor.christophercorbin.cloud/"'`
Expected: resolves to CloudFront; `200 0`; the canonical grep prints a match (confirms `site_origin` flipped to the custom domain).

---

### Task 6: Delete the orphan `christophercorbin.cloud` zone in eportfolio-prod

**Files:** none (AWS CLI, account `personal-eportfolio-prod`).

**Interfaces:**
- Consumes: nothing.
- Produces: removes the non-authoritative duplicate zone `Z04951261B19QOXRD4IUE`.

- [ ] **Step 1: Confirm it is the orphan and list its records**

Run: `aws route53 get-hosted-zone --id Z04951261B19QOXRD4IUE --profile personal-eportfolio-prod --query 'DelegationSet.NameServers' --output text`
Expected: nameservers `ns-786…`, `ns-368…`, `ns-1321…`, `ns-1922…` (NOT in the public delegation — confirms orphan). Then:
Run: `aws route53 list-resource-record-sets --id Z04951261B19QOXRD4IUE --profile personal-eportfolio-prod --query "ResourceRecordSets[?Type!='SOA' && Type!='NS']" --output json`
Expected: the apex A alias, `www` CNAME, and one ACM validation CNAME (all duplicates of records that also exist in the authoritative zone). Nothing unique.

- [ ] **Step 2: Delete the non-SOA/NS records**

For each record printed in Step 1, delete it with a change batch. Example for the apex A alias (repeat per record, substituting the exact values from Step 1's JSON):

```bash
aws route53 change-resource-record-sets --hosted-zone-id Z04951261B19QOXRD4IUE --profile personal-eportfolio-prod \
  --change-batch '{"Changes":[{"Action":"DELETE","ResourceRecordSet":<paste the exact ResourceRecordSet object from Step 1>}]}'
```

Expected: each returns a `ChangeInfo` with `Status: PENDING`.

- [ ] **Step 3: Delete the now-empty zone**

Run: `aws route53 delete-hosted-zone --id Z04951261B19QOXRD4IUE --profile personal-eportfolio-prod`
Expected: `ChangeInfo` returned (deletion succeeds only once the zone holds just its SOA + NS).

- [ ] **Step 4: Verify it is gone**

Run: `aws route53 list-hosted-zones --profile personal-eportfolio-prod --query "HostedZones[?Name=='christophercorbin.cloud.'].Id" --output text`
Expected: empty output (no christophercorbin.cloud zone in this account).

---

### Task 7: Update project memory

**Files:** none in-repo (agent memory).

- [ ] **Step 1: Record the outcome**

Update the memory note for this project (or the `forked-repo-gov`/domains context) with: the authoritative zone id, the `Route53RecordWriter` role ARN + external id pattern, and the two live subdomains. This makes the cross-account DNS pattern reusable for future apps.

---

## Notes for the implementer

- Run tasks in order: **Task 1 must complete before Tasks 3 and 5** (the role must exist before any app assumes it). Tasks 2/4 (config only) can be written any time; Tasks 3/5 (apply) depend on both the role and their config.
- If `tofu apply` for an app fails with `AccessDenied` on `sts:AssumeRole`, re-check the deploy account id is in the bootstrap `deploy_account_ids` and that `dns_external_id` matches.
- `personal-eportfolio-prod` is production. Never apply there without reviewing the plan output first.
