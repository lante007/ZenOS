# EvidenceOS Session Kickoff

Continuing EvidenceOS work.

- EC2: `i-05cb0d30211afe4a6` (us-east-1)
- App: `/home/ec2-user/ZenOS`
- Repo: `github.com/lante007/ZenOS`
- AWS: default profile (BursaryNetwork007)
- Latest commit: check with `git log --oneline -3`

## CRITICAL before any frontend build

```
echo "VITE_COGNITO_CLIENT_ID=5vieei8509fca2r05na4tjg619" > \
  /tmp/ZenOS-audit/frontend/.env.production
```

## Clone repo if not present

```
git clone https://github.com/lante007/ZenOS.git /tmp/ZenOS-audit
```

## Verify EC2

```
COMMAND_ID=$(aws ssm send-command \
  --instance-ids i-05cb0d30211afe4a6 \
  --document-name AWS-RunShellScript \
  --region us-east-1 \
  --parameters 'commands=["pm2 list && curl -s http://127.0.0.1:3001/api/health | head -c 150"]' \
  --query Command.CommandId \
  --output text)
echo $COMMAND_ID
sleep 25
aws ssm get-command-invocation \
  --command-id "$COMMAND_ID" \
  --instance-id i-05cb0d30211afe4a6 \
  --region us-east-1 \
  --query 'StandardOutputContent' \
  --output text
```

## Smoke test

`ZENEX_TEST_PASSWORD` must be set in your shell/secrets manager beforehand — do not hardcode the password in this file or in commit history.

```
TOKEN=$(aws cognito-idp initiate-auth \
  --client-id 5vieei8509fca2r05na4tjg619 \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=LanteTest@zenexfoundation.org.za,PASSWORD="$ZENEX_TEST_PASSWORD" \
  --region us-east-1 \
  --query 'AuthenticationResult.IdToken' \
  --output text)

curl -s https://zenex.auxeira.com/api/stats/cascade \
  -H "Authorization: Bearer $TOKEN" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
fc=d.get('financial_capital',{})
ec=d.get('evidence_capital',{})
print('Financial:', fc.get('value'))
print('avg_eqs:', ec.get('index'))
print('EROI:', d.get('eroi',{}).get('index'))
"
```

### Expected values

- Financial: `274937796`
- avg_eqs: `2.78`
- EROI: `37`

If any value is wrong: **STOP** and report before doing anything.

Report EC2 status and smoke test values before proceeding to any task.
