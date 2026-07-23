#!/bin/bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# EvidenceOS Infrastructure Setup — us-east-1
# Auxeira · Evidence intelligence infrastructure for philanthropy
# Run from Gitpod/Ona workspace after secrets are configured
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -e  # Stop on any error

REGION="us-east-1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
OUTPUTS_FILE="infra/outputs.json"
mkdir -p infra

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  EvidenceOS Infrastructure Setup"
echo "  Account: $ACCOUNT_ID | Region: $REGION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 1. S3 DOCUMENT VAULTS (private, encrypted) ────────────────
echo "[1/8] Creating S3 document vaults..."

for TENANT in zenex optima; do
  BUCKET="auxeira-evidenceos-${TENANT}"
  if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
    echo "  ✓ s3://${BUCKET} already exists"
  else
    aws s3api create-bucket \
      --bucket "$BUCKET" \
      --region "$REGION" \
      --create-bucket-configuration LocationConstraint="$REGION" \
      2>/dev/null || \
    aws s3api create-bucket \
      --bucket "$BUCKET" \
      --region "$REGION"
    
    # Block all public access
    aws s3api put-public-access-block \
      --bucket "$BUCKET" \
      --public-access-block-configuration \
        "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
    
    # Enable versioning
    aws s3api put-bucket-versioning \
      --bucket "$BUCKET" \
      --versioning-configuration Status=Enabled
    
    # Enable server-side encryption
    aws s3api put-bucket-encryption \
      --bucket "$BUCKET" \
      --server-side-encryption-configuration \
        '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
    
    # Create folder structure
    for PREFIX in raw/documents processed/text processed/records queue exports/knowledge exports/reports; do
      aws s3api put-object --bucket "$BUCKET" --key "${PREFIX}/.keep" --body /dev/null 2>/dev/null || true
    done
    
    echo "  ✓ s3://${BUCKET} created with encryption and versioning"
  fi
done

# ── 2. S3 STATIC WEBSITE BUCKETS (public, frontend) ──────────
echo "[2/8] Creating S3 static website buckets..."

for TENANT in zenex optima admin; do
  BUCKET="auxeira-web-${TENANT}"
  if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
    echo "  ✓ s3://${BUCKET} already exists"
  else
    aws s3api create-bucket \
      --bucket "$BUCKET" \
      --region "$REGION" \
      --create-bucket-configuration LocationConstraint="$REGION" \
      2>/dev/null || \
    aws s3api create-bucket \
      --bucket "$BUCKET" \
      --region "$REGION"
    
    # Configure as static website
    aws s3api put-bucket-website \
      --bucket "$BUCKET" \
      --website-configuration \
        '{"IndexDocument":{"Suffix":"index.html"},"ErrorDocument":{"Key":"index.html"}}'
    
    echo "  ✓ s3://${BUCKET} created as static website"
  fi
done

# Upload placeholder index.html for Zenex
cat > /tmp/placeholder.html << 'HTML'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Zenex Foundation · EvidenceOS</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #311F47; min-height: 100vh; display: flex; align-items: center; justify-content: center; font-family: 'Segoe UI', sans-serif; }
  .wrap { text-align: center; padding: 48px 32px; }
  .logo { font-size: 13px; color: rgba(255,255,255,0.4); letter-spacing: 3px; text-transform: uppercase; margin-bottom: 48px; }
  h1 { color: #fff; font-size: 32px; font-weight: 700; margin-bottom: 12px; }
  p { color: rgba(255,255,255,0.55); font-size: 15px; margin-bottom: 40px; line-height: 1.6; }
  a { display: inline-block; background: #EF7218; color: #fff; padding: 14px 40px; border-radius: 6px; font-size: 15px; font-weight: 600; text-decoration: none; transition: background 0.15s; }
  a:hover { background: #C85E0E; }
  .powered { margin-top: 48px; font-size: 11px; color: rgba(255,255,255,0.2); }
</style>
</head>
<body>
<div class="wrap">
  <div class="logo">Zenex Foundation</div>
  <h1>Evidence Intelligence Platform</h1>
  <p>Thirty years of Foundation Phase evidence,<br>classified and decision-ready.</p>
  <a href="/login">Sign In</a>
  <div class="powered">Powered by Auxeira EvidenceOS</div>
</div>
</body>
</html>
HTML

aws s3 cp /tmp/placeholder.html s3://auxeira-web-zenex/index.html \
  --content-type "text/html" --cache-control "no-cache"
echo "  ✓ Zenex landing page uploaded"

# ── 3. RDS POSTGRESQL ─────────────────────────────────────────
echo "[3/8] Creating RDS PostgreSQL instance..."

# Check if instance already exists
if aws rds describe-db-instances \
  --db-instance-identifier "evidenceos-db" \
  --region "$REGION" 2>/dev/null | grep -q "evidenceos-db"; then
  echo "  ✓ RDS instance already exists"
  RDS_ENDPOINT=$(aws rds describe-db-instances \
    --db-instance-identifier "evidenceos-db" \
    --query 'DBInstances[0].Endpoint.Address' \
    --output text)
else
  # Generate a secure password if not set
  if [ -z "$DB_PASSWORD" ]; then
    DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')
    echo "  ⚠ DB_PASSWORD not set. Generated: $DB_PASSWORD"
    echo "  ⚠ Save this password — add it to Ona Secrets as DB_PASSWORD"
  fi

  aws rds create-db-instance \
    --db-instance-identifier "evidenceos-db" \
    --db-instance-class "db.t3.micro" \
    --engine postgres \
    --engine-version "15.4" \
    --master-username "evidenceos_admin" \
    --master-user-password "$DB_PASSWORD" \
    --allocated-storage 20 \
    --storage-type gp2 \
    --db-name "evidenceos" \
    --backup-retention-period 7 \
    --no-multi-az \
    --publicly-accessible \
    --region "$REGION"

  echo "  ⏳ RDS creating (takes ~5 minutes)..."
  aws rds wait db-instance-available \
    --db-instance-identifier "evidenceos-db" \
    --region "$REGION"

  RDS_ENDPOINT=$(aws rds describe-db-instances \
    --db-instance-identifier "evidenceos-db" \
    --query 'DBInstances[0].Endpoint.Address' \
    --output text)
  
  echo "  ✓ RDS ready at: $RDS_ENDPOINT"
fi

# ── 4. COGNITO USER POOL — ZENEX ──────────────────────────────
echo "[4/8] Creating Cognito User Pool for Zenex Foundation..."

# Check if pool exists
EXISTING_POOL=$(aws cognito-idp list-user-pools --max-results 20 \
  --query "UserPools[?Name=='evidenceos-zenex'].Id" \
  --output text 2>/dev/null)

if [ -n "$EXISTING_POOL" ] && [ "$EXISTING_POOL" != "None" ]; then
  COGNITO_POOL_ID="$EXISTING_POOL"
  echo "  ✓ Cognito pool already exists: $COGNITO_POOL_ID"
else
  COGNITO_POOL_ID=$(aws cognito-idp create-user-pool \
    --pool-name "evidenceos-zenex" \
    --policies '{
      "PasswordPolicy": {
        "MinimumLength": 12,
        "RequireUppercase": true,
        "RequireLowercase": true,
        "RequireNumbers": true,
        "RequireSymbols": false
      }
    }' \
    --auto-verified-attributes email \
    --username-attributes email \
    --user-attribute-update-settings \
      '{"AttributesRequireVerificationBeforeUpdate":["email"]}' \
    --mfa-configuration OFF \
    --email-configuration '{
      "EmailSendingAccount": "COGNITO_DEFAULT"
    }' \
    --schema '[
      {"Name":"email","AttributeDataType":"String","Required":true,"Mutable":true},
      {"Name":"given_name","AttributeDataType":"String","Required":true,"Mutable":true},
      {"Name":"family_name","AttributeDataType":"String","Required":true,"Mutable":true},
      {"Name":"custom:role","AttributeDataType":"String","Required":false,"Mutable":true},
      {"Name":"custom:tenant_id","AttributeDataType":"String","Required":false,"Mutable":true}
    ]' \
    --query 'UserPool.Id' \
    --output text)
  
  echo "  ✓ Cognito pool created: $COGNITO_POOL_ID"
fi

# Create app client
COGNITO_CLIENT_ID=$(aws cognito-idp create-user-pool-client \
  --user-pool-id "$COGNITO_POOL_ID" \
  --client-name "evidenceos-zenex-web" \
  --generate-secret \
  --explicit-auth-flows \
    ALLOW_USER_PASSWORD_AUTH \
    ALLOW_REFRESH_TOKEN_AUTH \
    ALLOW_USER_SRP_AUTH \
  --supported-identity-providers COGNITO \
  --callback-urls \
    "https://zenex.auxeira.com/auth/callback" \
    "http://localhost:3000/auth/callback" \
  --logout-urls \
    "https://zenex.auxeira.com" \
    "http://localhost:3000" \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes openid email profile \
  --allowed-o-auth-flows-user-pool-client \
  --query 'UserPoolClient.ClientId' \
  --output text 2>/dev/null || \
  aws cognito-idp list-user-pool-clients \
    --user-pool-id "$COGNITO_POOL_ID" \
    --query 'UserPoolClients[0].ClientId' \
    --output text)

echo "  ✓ Cognito app client: $COGNITO_CLIENT_ID"

# Create Organisation Lead user for Zenex (Fatima)
aws cognito-idp admin-create-user \
  --user-pool-id "$COGNITO_POOL_ID" \
  --username "fatima@zenex.org.za" \
  --user-attributes \
    Name=email,Value="fatima@zenex.org.za" \
    Name=given_name,Value="Fatima" \
    Name=family_name,Value="Adam" \
    "Name=custom:role,Value=ORGANISATION_LEAD" \
    "Name=custom:tenant_id,Value=zenex" \
  --temporary-password "ZenexEvidence2026!" \
  --message-action SUPPRESS 2>/dev/null || true

echo "  ✓ Test user created: fatima@zenex.org.za / ZenexEvidence2026!"

# ── 5. CLOUDFRONT — ZENEX FRONTEND ────────────────────────────
echo "[5/8] Creating CloudFront distribution for zenex.auxeira.com..."

EXISTING_CF=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Origins.Items[?DomainName=='auxeira-web-zenex.s3-website-${REGION}.amazonaws.com']].Id" \
  --output text 2>/dev/null)

if [ -n "$EXISTING_CF" ] && [ "$EXISTING_CF" != "None" ]; then
  CF_DISTRIBUTION_ID="$EXISTING_CF"
  CF_DOMAIN=$(aws cloudfront get-distribution \
    --id "$CF_DISTRIBUTION_ID" \
    --query 'Distribution.DomainName' \
    --output text)
  echo "  ✓ CloudFront already exists: $CF_DISTRIBUTION_ID ($CF_DOMAIN)"
else
  CF_OUTPUT=$(aws cloudfront create-distribution \
    --distribution-config "{
      \"CallerReference\": \"evidenceos-zenex-$(date +%s)\",
      \"Origins\": {
        \"Quantity\": 1,
        \"Items\": [{
          \"Id\": \"zenex-s3-origin\",
          \"DomainName\": \"auxeira-web-zenex.s3-website-${REGION}.amazonaws.com\",
          \"CustomOriginConfig\": {
            \"HTTPPort\": 80,
            \"HTTPSPort\": 443,
            \"OriginProtocolPolicy\": \"http-only\"
          }
        }]
      },
      \"DefaultCacheBehavior\": {
        \"TargetOriginId\": \"zenex-s3-origin\",
        \"ViewerProtocolPolicy\": \"redirect-to-https\",
        \"CachePolicyId\": \"658327ea-f89d-4fab-a63d-7e88639e58f6\",
        \"Compress\": true,
        \"AllowedMethods\": {
          \"Quantity\": 2,
          \"Items\": [\"GET\", \"HEAD\"],
          \"CachedMethods\": {\"Quantity\": 2, \"Items\": [\"GET\", \"HEAD\"]}
        }
      },
      \"CustomErrorResponses\": {
        \"Quantity\": 1,
        \"Items\": [{
          \"ErrorCode\": 404,
          \"ResponsePagePath\": \"/index.html\",
          \"ResponseCode\": \"200\",
          \"ErrorCachingMinTTL\": 0
        }]
      },
      \"Comment\": \"EvidenceOS Zenex Foundation\",
      \"Enabled\": true,
      \"HttpVersion\": \"http2\",
      \"PriceClass\": \"PriceClass_100\"
    }" \
    --query '[Distribution.Id, Distribution.DomainName]' \
    --output text)
  
  CF_DISTRIBUTION_ID=$(echo "$CF_OUTPUT" | awk '{print $1}')
  CF_DOMAIN=$(echo "$CF_OUTPUT" | awk '{print $2}')
  echo "  ✓ CloudFront created: $CF_DISTRIBUTION_ID"
  echo "  ✓ CloudFront domain: $CF_DOMAIN"
  echo "  ⏳ Distribution deploying (15–20 min for global propagation)..."
fi

# ── 6. ROUTE 53 ────────────────────────────────────────────────
echo "[6/8] Configuring Route 53 for zenex.auxeira.com..."

HOSTED_ZONE_ID=$(aws route53 list-hosted-zones \
  --query "HostedZones[?Name=='auxeira.com.'].Id" \
  --output text | sed 's|/hostedzone/||')

if [ -z "$HOSTED_ZONE_ID" ]; then
  echo "  ✗ auxeira.com hosted zone not found in Route 53."
  echo "  ✗ Ensure auxeira.com is managed in this AWS account."
else
  echo "  ✓ Found hosted zone: $HOSTED_ZONE_ID"
  
  aws route53 change-resource-record-sets \
    --hosted-zone-id "$HOSTED_ZONE_ID" \
    --change-batch "{
      \"Changes\": [{
        \"Action\": \"UPSERT\",
        \"ResourceRecordSet\": {
          \"Name\": \"zenex.auxeira.com\",
          \"Type\": \"CNAME\",
          \"TTL\": 300,
          \"ResourceRecords\": [{\"Value\": \"${CF_DOMAIN}\"}]
        }
      }]
    }" > /dev/null
  
  echo "  ✓ zenex.auxeira.com → $CF_DOMAIN"
fi

# ── 7. SECRETS MANAGER ────────────────────────────────────────
echo "[7/8] Storing configuration in Secrets Manager..."

aws secretsmanager create-secret \
  --name "evidenceos/zenex/config" \
  --description "EvidenceOS Zenex Foundation tenant configuration" \
  --secret-string "{
    \"tenant_slug\": \"zenex\",
    \"org_name\": \"Zenex Foundation\",
    \"s3_bucket\": \"auxeira-evidenceos-zenex\",
    \"web_bucket\": \"auxeira-web-zenex\",
    \"cognito_pool_id\": \"${COGNITO_POOL_ID}\",
    \"cognito_client_id\": \"${COGNITO_CLIENT_ID}\",
    \"primary_color\": \"#EF7218\",
    \"secondary_color\": \"#311F47\",
    \"tier\": \"PROFESSIONAL\"
  }" 2>/dev/null || \
aws secretsmanager update-secret \
  --secret-id "evidenceos/zenex/config" \
  --secret-string "{
    \"tenant_slug\": \"zenex\",
    \"org_name\": \"Zenex Foundation\",
    \"s3_bucket\": \"auxeira-evidenceos-zenex\",
    \"web_bucket\": \"auxeira-web-zenex\",
    \"cognito_pool_id\": \"${COGNITO_POOL_ID}\",
    \"cognito_client_id\": \"${COGNITO_CLIENT_ID}\",
    \"primary_color\": \"#EF7218\",
    \"secondary_color\": \"#311F47\",
    \"tier\": \"PROFESSIONAL\"
  }" 2>/dev/null || true

echo "  ✓ Tenant config stored in Secrets Manager"

# ── 8. SAVE OUTPUTS ────────────────────────────────────────────
echo "[8/8] Saving infrastructure outputs..."

cat > "$OUTPUTS_FILE" << OUTPUTS
{
  "account_id": "${ACCOUNT_ID}",
  "region": "${REGION}",
  "rds_endpoint": "${RDS_ENDPOINT:-PENDING}",
  "rds_instance": "evidenceos-db",
  "rds_database": "evidenceos",
  "rds_username": "evidenceos_admin",
  "zenex_vault_bucket": "auxeira-evidenceos-zenex",
  "optima_vault_bucket": "auxeira-evidenceos-optima",
  "zenex_web_bucket": "auxeira-web-zenex",
  "zenex_cognito_pool_id": "${COGNITO_POOL_ID}",
  "zenex_cognito_client_id": "${COGNITO_CLIENT_ID}",
  "zenex_cf_distribution_id": "${CF_DISTRIBUTION_ID:-PENDING}",
  "zenex_cf_domain": "${CF_DOMAIN:-PENDING}",
  "zenex_subdomain": "zenex.auxeira.com",
  "route53_hosted_zone": "${HOSTED_ZONE_ID:-NOT_FOUND}",
  "secrets_manager_key": "evidenceos/zenex/config",
  "test_user_email": "fatima@zenex.org.za",
  "test_user_password": "ZenexEvidence2026!",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
OUTPUTS

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  INFRASTRUCTURE SETUP COMPLETE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
cat "$OUTPUTS_FILE" | python3 -m json.tool 2>/dev/null || cat "$OUTPUTS_FILE"
echo ""
echo "  Next: Run database migrations"
echo "  $ psql postgresql://evidenceos_admin:\$DB_PASSWORD@${RDS_ENDPOINT:-PENDING}:5432/evidenceos -f db/migrations/001_master_schema.sql"
echo ""
echo "  Then: Follow ONA_BUILD_PROMPT.md Phase 3 onwards."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
