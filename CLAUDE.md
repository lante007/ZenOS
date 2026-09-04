## Known Architectural Debt

### Multi-tenant Chief of Staff aggregation
The Chief of Staff currently resolves to a single tenant from request
context. Multi-tenant aggregation is required before the second paying
tenant is onboarded.
Trigger condition: second tenant within four weeks of onboarding.
Work required: getLiveCorpusData → getAllTenantsCorpusData,
Intelligence Console UI tenant selector, per-tenant context sections
in Chief of Staff system prompt.
Do not implement until trigger condition is met.

### Outcome-to-learning loop
intelligence_outcomes table exists and is append-only. Nothing
currently reads it to update future Advisor or Prophet behaviour.
This is the missing piece of the learning loop:
Outcome capture ✅ → Outcome → memory/learning → improved future
decision support ❌
Trigger condition: second intelligence cycle completed with at least
five recorded outcomes across different question types.
Work required: outcome reader that updates signal credibility scores,
memory temperature, and confidence weights based on recorded outcomes.

### Claim-level confidence model
Current confidence is response-level (UNKNOWN, LOW, MODERATE, HIGH).
Required: per-claim confidence with aggregated overall confidence
reflecting the actual source distribution.
Example: operational corpus metrics (live aggregate) are HIGH
confidence. Strategic interpretation (memory) is MODERATE. The
overall should reflect the mix, not collapse to UNKNOWN.
Trigger condition: next intelligence quality improvement sprint.

### Admin tenant header for local SSM access
When calling admin endpoints via SSM or localhost, pass:
x-evidenceos-tenant: admin
127.0.0.1/localhost defaults to the zenex tenant via slugFromHost()
and will 403 on admin-pool tokens without this header.

## Admin auth pattern note
Admin Cognito pool: us-east-1_RR62sMTY0, client 2cr63ditp2laakafpn0inh9urf
When calling admin endpoints via SSM/localhost:
- Pass header: x-evidenceos-tenant: admin
- slugFromHost() defaults 127.0.0.1 to zenex tenant
- Admin-pool tokens will 403 without this header
\n## EC2 Role — Frontend Deployment Policies\nEC2 role (EvidenceOSEC2Role) requires two inline policies for frontend deployment:\n- FrontendDeployS3Write: scoped to s3://auxeira-web-zenex\n- FrontendDeployCloudFrontInvalidate: scoped to E20OUWEKR52Y3E\nThese were added manually. If the role is recreated, re-add them.
