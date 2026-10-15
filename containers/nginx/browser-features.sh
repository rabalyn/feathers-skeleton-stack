#!/bin/sh
# The browser features a product's application uses (ADR 0018, 0035),
# named in product.env as PRODUCT_BROWSER_FEATURES, separated by blanks: in
# the application's Permissions-Policy, each `feature=()` becomes
# `feature=(self)`. Its own pages may use the feature, no other origin, not
# even in a frame. Run once, at the image build, on the snippet template.
# A name the policy does not switch off fails the build: a typo, or a
# feature the skeleton has not weighed yet, is added to the policy first.
set -eu
snippet=$1
for feature in ${PRODUCT_BROWSER_FEATURES:-}; do
  case $feature in
    *[!a-z-]* | -* | *-)
      echo "browser-features: '$feature' is no feature name" >&2
      exit 1
      ;;
  esac
  grep -Eq "[ \"]$feature=\(\)" "$snippet" || {
    echo "browser-features: '$feature' is not one the Permissions-Policy switches off" >&2
    exit 1
  }
  sed -E -i "s/([ \"])$feature=\(\)/\1$feature=(self)/" "$snippet"
  echo "browser-features: $feature=(self)"
done
