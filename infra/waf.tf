/**
 * WAFv2 web ACL for the CloudFront distribution (issue #22).
 *
 * Without this, the distribution is a thin pass-through to a single
 * 256 CPU / 512 MB Fargate task with no autoscaling — trivially DoS-able.
 * The managed rule groups (Common + Known Bad Inputs) cover the bulk of
 * generic layer-7 attacks; the rate-based rule caps any one IP at
 * 2,000 requests per 5-minute window, which is generous for a real
 * human (~7 req/s sustained) but kills bot floods cheaply.
 *
 * CloudFront-scoped WAFs MUST live in us-east-1; the default provider
 * is already configured for us-east-1 (see main.tf), so no aliased
 * provider is needed unless this stack is ever moved to another region.
 */

resource "aws_wafv2_web_acl" "cf" {
  name        = "hurricane-ready"
  description = "Hurricane-Ready CloudFront protection"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # AWS Managed: OWASP-style common attacks (SQLi probes, XSS payloads,
  # PHP unserialize, etc). Keep all subrules in count-only-no-overrides
  # mode by setting `override_action { none {} }` so the rule group's
  # default block actions apply.
  rule {
    name     = "common-rule-set"
    priority = 1
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "hurricane-ready-common-rule-set"
      sampled_requests_enabled   = true
    }
  }

  # AWS Managed: known-malicious request patterns (path traversal,
  # session fixation, Log4Shell-style header injection).
  rule {
    name     = "known-bad-inputs"
    priority = 2
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "hurricane-ready-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  # Rate limit: per source IP, 2000 requests / 5 minutes. The dashboard
  # polls /api/status every 60s — well under the cap. Set generously so
  # a legitimate user behind shared NAT (e.g. a school or workplace)
  # doesn't get throttled by accident.
  rule {
    name     = "rate-limit"
    priority = 3
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "hurricane-ready-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "hurricane-ready-waf"
    sampled_requests_enabled   = true
  }
}
