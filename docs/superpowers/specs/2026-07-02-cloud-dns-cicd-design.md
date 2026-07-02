# cloud-dns repo + CI/CD — design

**Date:** 2026-07-02
**Status:** Approved (design), pending implementation plan
**Parent:** `2026-07-02-custom-domains-design.md` (this replaces that plan's Task 1 "local apply" with a CI/CD-managed deploy of the shared `Route53RecordWriter` role).

## Goal

A dedicated GitHub repo, **`cloud-dns`**, that owns the shared cross-account DNS bootstrap and deploys it through CI/CD instead of local `tofu apply`:

- Terraform manages the `Route53RecordWriter` IAM role in the DNS/management account.
- GitHub Actions authenticates to AWS via **OIDC** (no stored keys), runs `tofu plan` on PRs and **auto-applies on merge to `main`** (no manual approval gate — explicit choice).
- Terraform state is remote (S3 + DynamoDB lock) so every CI run and any operator share one state.

## Environment (verified 2026-07-02)

| Piece | Value |
|---|---|
| DNS/management account | 438465156498 (`personal-christopher-corbin`) |
| Authoritative hosted zone | `Z08882413R82BOPJVWS7Z` (`christophercorbin.cloud`) |
| Consuming deploy accounts (assume the role) | 385467776718 (sandbox), 590716168923 (eportfolio-prod) |
| GitHub repo | `christophercorbin/cloud-dns` |
| Region | us-east-1 |

The `Route53RecordWriter` trust policy already targets the two deploy-account roots with external id `corbin-dns-delegation`; unchanged by this work.

## Approach (chosen): ① CLI seed script

A committed `seed.sh` (AWS CLI), run **once** by the operator with mgmt admin creds, creates the four things CI depends on but cannot create itself. After the seed, all ongoing changes — including the `Route53RecordWriter` role — go through Terraform via CI. No Terraform state files on any laptop.

Rejected: ② two-state Terraform (stray local state), ③ import-after-seed (fiddliest setup).

## Bootstrap ordering (the chicken-and-egg)

1. **Seed (once, manual, mgmt admin):** `seed.sh` creates: S3 state bucket, DynamoDB lock table, GitHub OIDC provider, CI deploy role.
2. **CI (ongoing):** assumes the CI deploy role via OIDC, uses the S3 backend, and manages `Route53RecordWriter`.

The seed's four resources are stable identity/backing infra, created outside Terraform state deliberately; documented in the repo README. `seed.sh` is idempotent (checks existence before create) so re-running is safe.

## Components

### A. `seed.sh` (one-time, AWS CLI, profile `personal-christopher-corbin`)

Creates, idempotently:
- **S3 bucket** `cloud-dns-tfstate-438465156498` — versioning on, public access blocked, SSE-S3 (AES256) default encryption.
- **DynamoDB table** `cloud-dns-tflock` — `PAY_PER_REQUEST`, hash key `LockID` (S).
- **GitHub OIDC provider** for `token.actions.githubusercontent.com` — **only if one does not already exist** in the account (an account may have exactly one provider per URL; reuse it if present).
- **CI deploy role** `cloud-dns-ci` — trust: web-identity federated to the OIDC provider, condition `token.actions.githubusercontent.com:aud = sts.amazonaws.com` and `:sub` matching `repo:christophercorbin/cloud-dns:ref:refs/heads/main` (apply) and `repo:christophercorbin/cloud-dns:pull_request` (plan). Permissions (least privilege):
  - IAM: manage only the record-writer role — `iam:GetRole`, `CreateRole`, `DeleteRole`, `TagRole`, `PutRolePolicy`, `GetRolePolicy`, `DeleteRolePolicy`, `ListRolePolicies`, `UpdateAssumeRolePolicy` scoped to `arn:aws:iam::438465156498:role/Route53RecordWriter`.
  - State: `s3:GetObject`/`PutObject`/`ListBucket` on the state bucket + prefix; `dynamodb:GetItem`/`PutItem`/`DeleteItem` on the lock table.

**Contract:** _does_ — creates CI's auth + state backing. _use_ — run once before the first CI run. _depends on_ — mgmt admin credentials.

### B. Terraform root (`main.tf`, `backend.tf`, `versions.tf`)

- `backend.tf`: S3 backend → bucket `cloud-dns-tfstate-438465156498`, key `cloud-dns/terraform.tfstate`, region us-east-1, DynamoDB lock table `cloud-dns-tflock`, `encrypt = true`.
- `main.tf`: the `Route53RecordWriter` role + scoped inline policy — the exact config already written and validated for the parent plan (role name, trust = deploy-account roots + external id `corbin-dns-delegation`, permissions scoped to zone `Z08882413R82BOPJVWS7Z`; `route53:GetChange` on `change/*`; list ops on `*`). Output `role_arn`.
- `versions.tf`: `required_version >= 1.6`, `hashicorp/aws ~> 5.0`.

### C. GitHub Actions (`.github/workflows/`)

- `plan.yml` — `on: pull_request`. Permissions `id-token: write`, `contents: read`, `pull-requests: write`. Steps: checkout → setup OpenTofu (pinned version) → `configure-aws-credentials` (OIDC, `role-to-assume = cloud-dns-ci`) → `tofu init` → `tofu fmt -check` → `tofu validate` → `tofu plan -no-color` → post plan as a PR comment.
- `apply.yml` — `on: push: branches: [main]`. Permissions `id-token: write`, `contents: read`. Steps: checkout → setup OpenTofu → OIDC creds → `tofu init` → `tofu apply -auto-approve`.
- All third-party actions **SHA-pinned** (repo convention: hurricane-ready pins actions by SHA).

## Verification

- `seed.sh` run twice in a row is a no-op the second time (idempotent).
- Opening a PR triggers `plan.yml`; the plan comment shows `Route53RecordWriter` to add.
- Merging to `main` triggers `apply.yml`; `aws iam get-role --role-name Route53RecordWriter --profile personal-christopher-corbin` returns the ARN.
- A deploy-account principal can assume the role with external id `corbin-dns-delegation` (smoke: `aws sts assume-role` from sandbox).

## Out of scope (follow-on specs)

- The two apps' own apply pipelines (Bim Weather in sandbox, math-mentor in prod). This repo only deploys the shared role; the apps continue to consume it.
- Moving Bim Weather from sandbox to prod.

## Risks / notes

- **Auto-apply to the mgmt account with no manual gate** is the explicit choice; blast radius is limited because the CI role can only touch the one IAM role + its own state. Revisit if the repo's scope ever widens.
- **OIDC provider uniqueness:** only one provider per URL per account. `seed.sh` must detect and reuse an existing `token.actions.githubusercontent.com` provider rather than fail/duplicate.
- **Seed drift:** the four seed resources live outside Terraform state by design; changes to them are manual (edit `seed.sh`, re-run). Acceptable for stable bootstrap infra.
- The `Route53RecordWriter` config is identical to the parent plan's Task 1; that task is now delivered here instead of via local apply.
