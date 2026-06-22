/**
 * Public entry point: CloudFront -> VPC Origin -> internal ALB -> ECS task.
 * The ALB is internal=true (see ecs.tf), so this distribution is the *only*
 * way in from the internet.
 */

# ---------- VPC Origin: CloudFront's connection to the internal ALB ----------

resource "aws_cloudfront_vpc_origin" "alb" {
  vpc_origin_endpoint_config {
    name                   = "hurricane-ready-alb"
    arn                    = aws_lb.app.arn
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "http-only"

    # Required field even though we use HTTP. CloudFront ignores SSL settings
    # when origin_protocol_policy=http-only.
    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }
}

# ---------- Security response headers ----------
# Adds HSTS, a content-security policy, and the usual hardening headers to
# every response. CSP allows the inline <script>/<style> the dashboard relies
# on plus the Leaflet CDN and CARTO basemap tiles; the API the browser calls
# (/api/status) is same-origin, so connect-src 'self' is sufficient.

resource "aws_cloudfront_response_headers_policy" "security" {
  name = "hurricane-ready-security-headers"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 63072000 # 2 years
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    content_security_policy {
      override = true
      content_security_policy = join("; ", [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
        "img-src 'self' data: https://*.basemaps.cartocdn.com https://*.rainviewer.com https://cdn.star.nesdis.noaa.gov",
        "connect-src 'self' https://api.rainviewer.com",
        "font-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ])
    }
  }
}

# ---------- CloudFront distribution ----------

resource "aws_cloudfront_distribution" "app" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "hurricane-ready"
  price_class     = "PriceClass_100" # US + EU edges only — Caribbean audience is served by both

  # WAFv2 ACL: managed common-rule-set + known-bad-inputs + per-IP rate cap.
  # See waf.tf. Closes #22 — the origin task is no longer a single-flight
  # DoS target.
  web_acl_id = aws_wafv2_web_acl.cf.arn

  origin {
    domain_name = aws_lb.app.dns_name
    origin_id   = "alb-vpc-origin"

    vpc_origin_config {
      vpc_origin_id = aws_cloudfront_vpc_origin.alb.id
    }
  }

  # Default behavior: respect origin Cache-Control headers (issue #24).
  # CachingOptimized lets icons / OG image / preloaded assets cache at the
  # edge (origin sends `public, max-age=86400`) while the service worker and
  # manifest stay live (origin sends `no-cache`).
  default_cache_behavior {
    target_origin_id       = "alb-vpc-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6" # CachingOptimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # Belt-and-suspenders: pin dynamic endpoints to CachingDisabled so even if
  # origin Cache-Control headers ever drifted, these never cache at the edge.
  # `/` and `/index.html` cover the dashboard HTML, which the origin sends
  # without a Cache-Control header — under CachingOptimized that would
  # default to a 24h TTL and viewers would see stale HTML for up to a day
  # after each deploy (no invalidation is wired up in release.yml).
  # /api/* covers /api/status (polled every 60s) and the push subscribe
  # endpoints. /healthz must always reach the origin so health probes see
  # the live `persistenceBroken` / `stale` flags.
  ordered_cache_behavior {
    path_pattern           = "/"
    target_origin_id       = "alb-vpc-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
    origin_request_policy_id   = "216adef6-5c7f-47e4-b989-5492eafa07d3" # AllViewer
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  ordered_cache_behavior {
    path_pattern           = "/index.html"
    target_origin_id       = "alb-vpc-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
    origin_request_policy_id   = "216adef6-5c7f-47e4-b989-5492eafa07d3" # AllViewer
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "alb-vpc-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
    origin_request_policy_id   = "216adef6-5c7f-47e4-b989-5492eafa07d3" # AllViewer
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  ordered_cache_behavior {
    path_pattern           = "/healthz"
    target_origin_id       = "alb-vpc-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
    origin_request_policy_id   = "216adef6-5c7f-47e4-b989-5492eafa07d3" # AllViewer
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  viewer_certificate {
    # Default *.cloudfront.net cert. Swap to ACM (us-east-1) + aliases when
    # there's a real domain to point at this.
    cloudfront_default_certificate = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}

# ---------- Outputs ----------

output "dashboard_url" {
  description = "Public dashboard URL (CloudFront)"
  value       = "https://${aws_cloudfront_distribution.app.domain_name}"
}
