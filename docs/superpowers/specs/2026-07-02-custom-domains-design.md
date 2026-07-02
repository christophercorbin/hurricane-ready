# Custom domains for math-mentor and Bim Weather — design

**Date:** 2026-07-02
**Status:** Approved (design), pending implementation plan
**Scope:** Two separate repos + one shared bootstrap. This spec is cross-repo; it lives in `hurricane-ready` for convenience but governs work in `math-mentor` as well.

## Goal

Serve both apps on branded subdomains of `christophercorbin.cloud` over HTTPS with automatically-managed, DNS-validated ACM certificates:

- **math-mentor** → `mathmentor.christophercorbin.cloud`
- **Bim Weather** (hurricane-ready) → `bimweather.christophercorbin.cloud`

The apex `christophercorbin.cloud` already serves the portfolio site (CloudFront `d1kknbou1phexd`) and is untouched.

## Environment (verified 2026-07-02)

| Piece | Account | Profile |
|---|---|---|
| Authoritative DNS zone `christophercorbin.cloud` (`Z08882413R82BOPJVWS7Z`) | 438465156498 | `personal-christopher-corbin` (mgmt, …6498) |
| math-mentor deployment | 590716168923 | `personal-eportfolio-prod` |
| Bim Weather deployment | 385467776718 | `personal-sandbox` |

- The mgmt zone's 4 nameservers exactly match the public registrar delegation → it is authoritative.
- A **duplicate** `christophercorbin.cloud` zone exists in eportfolio-prod (`Z04951261B19QOXRD4IUE`) whose nameservers are NOT delegated → orphan; records there do not resolve. Cleanup candidate.
- ACM certs for CloudFront must be created in **us-east-1**.

## No Cloudflare

This is 100% AWS: Route53 (DNS) + ACM (certs) + CloudFront + IAM, all via the `aws` Terraform provider. math-mentor's existing code assumed Cloudflare DNS (the `domain_ready` two-step, manual CNAMEs); that is removed. The only remaining `cloudflare` string in either repo is `cdnjs.cloudflare.com` — a public CDN for static JS libraries (KaTeX, marked, DOMPurify, Leaflet), unrelated to DNS or this work.

## Approach (chosen)

**Shared mgmt IAM role + aliased `aws.dns` provider per app.** A single least-privilege role in the mgmt account, assumed by each app's Terraform, lets each app create its own ACM DNS-validation records and CloudFront alias record automatically. Reproducible, no manual DNS, least privilege. (Alternatives considered: self-contained per-app roles / manual record entry; a central DNS repo. Rejected as either more manual or more moving parts for two subdomains.)

## Components

### A. Bootstrap — mgmt account (one-time)

Create IAM role `Route53RecordWriter` in account 438465156498.

- **Trust policy:** allows `sts:AssumeRole` from the two deploy accounts, `385467776718` (sandbox) and `590716168923` (eportfolio-prod). Scope to the accounts' Terraform/admin principals (root-of-account or specific role ARNs — decide in plan; account-root trust + external-id acceptable for a personal setup).
- **Permissions policy (least privilege):**
  - `route53:ChangeResourceRecordSets`, `route53:ListResourceRecordSets` on `arn:aws:route53:::hostedzone/Z08882413R82BOPJVWS7Z`
  - `route53:GetChange` on `arn:aws:route53:::change/*`
  - `route53:ListHostedZonesByName` (list is `*`, read-only)
- **Home:** a minimal Terraform config (`bootstrap/` or applied via the mgmt profile once). Documented so it is reproducible, not click-ops.

**Unit contract:** _does_ — grants scoped Route53 write into the one zone. _use_ — deploy accounts assume it via an aliased provider. _depends on_ — the mgmt account + the hosted zone id.

### B. math-mentor (`personal-eportfolio-prod`)

Rework the existing Cloudflare-oriented custom-domain code:

- Add provider `aws.dns` = default provider config + `assume_role { role_arn = <Route53RecordWriter> }`.
- ACM cert (us-east-1) for `mathmentor.christophercorbin.cloud`, DNS validation.
- Create the ACM validation CNAME(s) in the authoritative zone via `aws.dns`.
- `aws_acm_certificate_validation` gates cert readiness.
- CloudFront: attach alias + validated cert (existing `use_custom_domain` local, simplified — no more `domain_ready` two-step).
- Create alias `A`/`AAAA` record `mathmentor.christophercorbin.cloud` → CloudFront distribution, via `aws.dns`.
- Remove `domain_ready` variable and Cloudflare assumptions; keep `domain_name` (default already correct).
- Confirm canonical/OG URLs resolve to the custom domain (infra already computes `site_origin`; ensure it flips to the domain).

### C. Bim Weather / hurricane-ready (`personal-sandbox`)

Enhance the currently-manual flow (which takes `acm_certificate_arn` + `aliases` as inputs) into the same automated shape:

- Add provider `aws.dns` assuming `Route53RecordWriter`.
- Create ACM cert (us-east-1) for `bimweather.christophercorbin.cloud`, DNS-validated via `aws.dns`.
- Feed the created/validated cert ARN into the existing CloudFront `viewer_certificate` + `aliases` wiring (refactor the two input variables into locals sourced from the managed cert; keep a var to enable/disable the whole custom-domain block).
- Create alias `A`/`AAAA` record `bimweather.christophercorbin.cloud` → CloudFront (distribution sits in front of the internal ALB via VPC origin; CloudFront still terminates TLS at the edge with the ACM cert).

### D. Cleanup

Delete the orphan `christophercorbin.cloud` zone in eportfolio-prod (`Z04951261B19QOXRD4IUE`) after confirming it holds nothing referenced. Prevents future confusion / silent non-resolving records.

### E. Verification (per app)

- `aws_acm_certificate` reaches `ISSUED`.
- `dig +short <subdomain>` returns the CloudFront distribution.
- `curl -Iv https://<subdomain>` → HTTP 200 with a valid cert for that name (no TLS name mismatch).
- App loads in a browser; canonical/OG reflect the custom domain (math-mentor).

## Out of scope

- Moving Bim Weather from sandbox to prod (explicitly deferred).
- www/apex redirects for the app subdomains (not needed).
- DNSSEC changes.

## Risks / notes

- **Cross-account trust blast radius:** the role is write-scoped to a single hosted zone and three low-risk Route53 actions; acceptable. Consider an `external_id` for defense in depth.
- **CloudFront + ACM region:** cert must be us-east-1 regardless of app region.
- **Ordering:** bootstrap role must exist before either app apply. Cert validation waits on DNS propagation; `aws_acm_certificate_validation` handles the wait.
- **Sandbox permanence:** Bim Weather staying in sandbox means the trust policy must include the sandbox account; revisit if it later moves to prod.
