#!/bin/bash
# EvidenceOS AWS Infrastructure Setup
# Auxeira · us-east-1
# Run this in your terminal after configuring AWS credentials
# Usage: bash infra/setup.sh

set -e

REGION="us-east-1"
DOMAIN="auxeira.com"
TENANT="zenex"
SUBDOMAIN="${TENANT}.${DOMAIN}"
BUCKET_WEB="auxeira-web-${TENANT}"
BUCKET_DOCS="auxeira-evidenceos-${TENANT}"
BUCKET_ADMIN="auxeira-web-admin"
DB_INSTANCE="evidenceos-db"
DB_NAME="evidenceos"
DB_USER="auxeira_admin"
COGNITO_POOL_NAME="evidenceos-${TENANT}"

echo ""
echo "═══════════════════════════════════════════════════"
echo "  EvidenceOS Infrastructure Setup · us-east-1"
echo "  Tenant: ${TENANT} · Domain: ${SUBDOMAIN}"
echo "═══════════════════════════════════════════════════"
echo ""

# ── VERIFY CREDENTIALS ──────────────────────────────────
echo "▶ Verifying AWS credentials..."
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "  Account: ${ACCOUNT_ID} ✓"

# ── S3: DOCUMENT STORAGE BUCKET (private) ───────────────
echo ""
echo "▶ Creating S3 document storage bucket: ${BUCKET_DOCS}"
aws s3api create-bucket \
  --bucket "${BUCKET_DOCS}" \
  --region "${REGION}" \
  2>/dev/null || echo "  Bucket already exists, continuing..."

aws s3api put-bucket-versioning \
  --bucket "${BUCKET_DOCS}" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket "${BUCKET_DOCS}" \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'

aws s3api put-public-access-block \
  --bucket "${BUCKET_DOCS}" \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

# Create folder structure
for PREFIX in raw/documents processed/text processed/records queue exports/knowledge exports/reports; do
  aws s3api put-object --bucket "${BUCKET_DOCS}" --key "${PREFIX}/" > /dev/null
done

echo "  ${BUCKET_DOCS} created and configured ✓"

# ── S3: WEBSITE BUCKET (zenex frontend) ─────────────────
echo ""
echo "▶ Creating S3 website bucket: ${BUCKET_WEB}"
aws s3api create-bucket \
  --bucket "${BUCKET_WEB}" \
  --region "${REGION}" \
  2>/dev/null || echo "  Bucket already exists, continuing..."

aws s3api put-bucket-versioning \
  --bucket "${BUCKET_WEB}" \
  --versioning-configuration Status=Enabled

echo "  ${BUCKET_WEB} created ✓"

# ── S3: ADMIN WEBSITE BUCKET ────────────────────────────
echo ""
echo "▶ Creating S3 admin website bucket: ${BUCKET_ADMIN}"
aws s3api create-bucket \
  --bucket "${BUCKET_ADMIN}" \
  --region "${REGION}" \
  2>/dev/null || echo "  Bucket already exists, continuing..."

echo "  ${BUCKET_ADMIN} created ✓"

# ── COGNITO USER POOL ────────────────────────────────────
echo ""
echo "▶ Creating Cognito User Pool: ${COGNITO_POOL_NAME}"
POOL_ID=$(aws cognito-idp create-user-pool \
  --pool-name "${COGNITO_POOL_NAME}" \
  --region "${REGION}" \
  --policies '{
    "PasswordPolicy": {
      "MinimumLength": 12,
      "RequireUppercase": true,
      "RequireLowercase": true,
      "RequireNumbers": true,
      "RequireSymbols": true,
      "TemporaryPasswordValidityDays": 7
    }
  }' \
  --auto-verified-attributes email \
  --username-attributes email \
  --mfa-configuration OFF \
  --account-recovery-setting '{
    "RecoveryMechanisms": [{"Priority": 1, "Name": "verified_email"}]
  }' \
  --schema '[
    {"Name":"email","Required":true,"Mutable":true},
    {"Name":"custom:role","AttributeDataType":"String","Mutable":true},
    {"Name":"custom:tenant","AttributeDataType":"String","Mutable":true}
  ]' \
  --query 'UserPool.Id' \
  --output text 2>/dev/null) || POOL_ID=$(aws cognito-idp list-user-pools \
    --max-results 20 \
    --region "${REGION}" \
    --query "UserPools[?Name=='${COGNITO_POOL_NAME}'].Id" \
    --output text)

echo "  User Pool ID: ${POOL_ID} ✓"

# Create App Client
CLIENT_ID=$(aws cognito-idp create-user-pool-client \
  --user-pool-id "${POOL_ID}" \
  --client-name "evidenceos-web" \
  --region "${REGION}" \
  --no-generate-secret \
  --explicit-auth-flows \
    ALLOW_USER_PASSWORD_AUTH \
    ALLOW_REFRESH_TOKEN_AUTH \
    ALLOW_USER_SRP_AUTH \
  --supported-identity-providers COGNITO \
  --callback-urls "https://${SUBDOMAIN}/auth/callback" "http://localhost:3000/auth/callback" \
  --logout-urls "https://${SUBDOMAIN}/" "http://localhost:3000/" \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes email openid profile \
  --allowed-o-auth-flows-user-pool-client \
  --query 'UserPoolClient.ClientId' \
  --output text 2>/dev/null) || CLIENT_ID="already-exists"

echo "  App Client ID: ${CLIENT_ID} ✓"

# Configure Hosted UI domain
POOL_DOMAIN="${TENANT}-evidenceos-$(echo $ACCOUNT_ID | tail -c 5)"
aws cognito-idp create-user-pool-domain \
  --domain "${POOL_DOMAIN}" \
  --user-pool-id "${POOL_ID}" \
  --region "${REGION}" \
  2>/dev/null || echo "  Cognito domain already configured"

echo "  Cognito Hosted UI: https://${POOL_DOMAIN}.auth.${REGION}.amazoncognito.com ✓"

# ── RDS POSTGRESQL ───────────────────────────────────────
echo ""
echo "▶ Checking RDS PostgreSQL instance: ${DB_INSTANCE}"
DB_STATUS=$(aws rds describe-db-instances \
  --db-instance-identifier "${DB_INSTANCE}" \
  --region "${REGION}" \
  --query 'DBInstances[0].DBInstanceStatus' \
  --output text 2>/dev/null) || DB_STATUS="none"

if [ "${DB_STATUS}" == "none" ] || [ "${DB_STATUS}" == "None" ]; then
  echo "  Creating RDS instance (takes ~5 minutes)..."
  DB_PASS=$(openssl rand -base64 24 | tr -d '/@"' | head -c 24)

  aws rds create-db-instance \
    --db-instance-identifier "${DB_INSTANCE}" \
    --db-instance-class db.t3.medium \
    --engine postgres \
    --engine-version "15.18" \
    --master-username "${DB_USER}" \
    --master-user-password "${DB_PASS}" \
    --allocated-storage 20 \
    --max-allocated-storage 100 \
    --storage-type gp3 \
    --storage-encrypted \
    --db-name "${DB_NAME}" \
    --publicly-accessible \
    --backup-retention-period 7 \
    --region "${REGION}" \
    --tags Key=Project,Value=EvidenceOS Key=Tenant,Value=${TENANT} \
    > /dev/null

  # Store password in Secrets Manager
  aws secretsmanager create-secret \
    --name "evidenceos/db/master-password" \
    --secret-string "{\"username\":\"${DB_USER}\",\"password\":\"${DB_PASS}\",\"dbname\":\"${DB_NAME}\"}" \
    --region "${REGION}" \
    > /dev/null

  echo "  RDS instance creating... check AWS console in 5 minutes ✓"
  echo "  DB password stored in Secrets Manager: evidenceos/db/master-password"
else
  echo "  RDS instance already exists: ${DB_STATUS} ✓"
fi

# ── SQS QUEUE ────────────────────────────────────────────
echo ""
echo "▶ Creating SQS queue: evidenceos-classify-${TENANT}"
QUEUE_URL=$(aws sqs create-queue \
  --queue-name "evidenceos-classify-${TENANT}" \
  --attributes '{
    "VisibilityTimeout": "900",
    "MessageRetentionPeriod": "86400",
    "ReceiveMessageWaitTimeSeconds": "20"
  }' \
  --region "${REGION}" \
  --query 'QueueUrl' \
  --output text 2>/dev/null) || QUEUE_URL="already-exists"

echo "  Queue URL: ${QUEUE_URL} ✓"

# ── SECRETS MANAGER: ANTHROPIC KEY ──────────────────────
echo ""
echo "▶ Creating Secrets Manager entries..."
aws secretsmanager create-secret \
  --name "evidenceos/${TENANT}/anthropic-key" \
  --description "Anthropic API key for EvidenceOS Zenex tenant" \
  --secret-string "REPLACE_WITH_YOUR_ANTHROPIC_API_KEY" \
  --region "${REGION}" \
  2>/dev/null || echo "  Secret already exists"

aws secretsmanager create-secret \
  --name "evidenceos/master/jwt-secret" \
  --description "JWT signing secret for EvidenceOS" \
  --secret-string "$(openssl rand -hex 32)" \
  --region "${REGION}" \
  2>/dev/null || echo "  JWT secret already exists"

echo "  Secrets created ✓"
echo "  IMPORTANT: Update evidenceos/${TENANT}/anthropic-key with your real Anthropic API key"

# ── ROUTE 53: CHECK HOSTED ZONE ──────────────────────────
echo ""
echo "▶ Checking Route 53 hosted zone for ${DOMAIN}..."
ZONE_ID=$(aws route53 list-hosted-zones \
  --query "HostedZones[?Name=='${DOMAIN}.'].Id" \
  --output text | sed 's|/hostedzone/||')

if [ -z "${ZONE_ID}" ]; then
  echo "  ⚠ No hosted zone found for ${DOMAIN}"
  echo "  Create one at: https://console.aws.amazon.com/route53"
else
  echo "  Hosted Zone ID: ${ZONE_ID} ✓"
fi

# ── CLOUDFRONT: REQUEST SSL CERTIFICATE ──────────────────
echo ""
echo "▶ Requesting SSL certificate for *.${DOMAIN}..."
CERT_ARN=$(aws acm request-certificate \
  --domain-name "*.${DOMAIN}" \
  --subject-alternative-names "${DOMAIN}" \
  --validation-method DNS \
  --region us-east-1 \
  --query 'CertificateArn' \
  --output text 2>/dev/null) || CERT_ARN="already-requested"

echo "  Certificate ARN: ${CERT_ARN}"
echo "  ⚠ Validate the certificate via DNS in ACM console before CloudFront step"

# ── SUMMARY ──────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
echo "  SETUP COMPLETE — Save these values"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  S3 docs bucket:    ${BUCKET_DOCS}"
echo "  S3 web bucket:     ${BUCKET_WEB}"
echo "  S3 admin bucket:   ${BUCKET_ADMIN}"
echo "  Cognito Pool ID:   ${POOL_ID}"
echo "  Cognito Client ID: ${CLIENT_ID}"
echo "  Cognito Domain:    ${POOL_DOMAIN}.auth.${REGION}.amazoncognito.com"
echo "  SQS Queue:         evidenceos-classify-${TENANT}"
echo "  Route 53 Zone:     ${ZONE_ID}"
echo "  SSL Cert:          ${CERT_ARN}"
echo ""
echo "  NEXT STEPS:"
echo "  1. Rotate your AWS keys immediately (you shared them in chat)"
echo "  2. Update Anthropic key: aws secretsmanager update-secret"
echo "     --secret-id evidenceos/${TENANT}/anthropic-key"
echo "     --secret-string 'YOUR_REAL_ANTHROPIC_KEY'"
echo "  3. Validate SSL certificate in ACM console (DNS validation)"
echo "  4. Wait ~5 min for RDS, then run: bash infra/db-setup.sh"
echo "  5. Deploy landing page: bash infra/deploy-landing.sh"
echo ""
echo "═══════════════════════════════════════════════════"
