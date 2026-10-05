#Requires -Version 5.1
# OLP quickstart cho Windows PowerShell (tương đương examples/quickstart/demo.sh)
param([string]$Base = "http://localhost:8080")
$H = @{}
Write-Host "== login =="
$login = Invoke-RestMethod -Method Post "$Base/v1/auth/login" -ContentType "application/json" -Body '{"email":"demo@acme.local","orgSlug":"acme"}'
$tok = $login.accessToken; $uid = $login.user.id
$H = @{ Authorization = "Bearer $tok" }
Write-Host "TOK len=$($tok.Length) UID=$uid"
Write-Host "== orgs =="
$orgs = Invoke-RestMethod "$Base/v1/orgs" -Headers $H
$org = $orgs[0].id; Write-Host "ORG=$org"
Write-Host "== create account (idempotent) =="
try {
  $acc = Invoke-RestMethod -Method Post "$Base/v1/orgs/$org/accounts" -ContentType "application/json" -Headers $H -Body '{"slug":"prod","displayName":"Production"}'
} catch {
  $acc = (Invoke-RestMethod "$Base/v1/orgs/$org/accounts" -Headers $H | Where-Object { $_.slug -eq "prod" })[0]
}
Write-Host "ACC=$($acc.id)"
Write-Host "== role + policy (idempotent) =="
try { $role = Invoke-RestMethod -Method Post "$Base/v1/accounts/$($acc.id)/roles" -ContentType "application/json" -Headers $H -Body '{"slug":"runner"}' }
catch { $role = (Invoke-RestMethod "$Base/v1/accounts/$($acc.id)/roles" -Headers $H | Where-Object { $_.slug -eq "runner" })[0] }
try {
  $pol = Invoke-RestMethod -Method Post "$Base/v1/accounts/$($acc.id)/policies" -ContentType "application/json" -Headers $H -Body '{"slug":"run-only","document":{"Version":"2026-01-01","Statement":[{"Effect":"Allow","Action":["workflow:Execute"],"Resource":"*"},{"Effect":"Deny","Action":["iam:*"],"Resource":"*"}]}}'
} catch { $pol = (Invoke-RestMethod "$Base/v1/accounts/$($acc.id)/policies" -Headers $H | Where-Object { $_.slug -eq "run-only" })[0] }
Invoke-RestMethod -Method Post "$Base/v1/roles/$($role.id)/attach" -ContentType "application/json" -Headers $H -Body (@{policyId=$pol.id} | ConvertTo-Json) | Out-Null
Invoke-RestMethod -Method Post "$Base/v1/users/$uid/assign" -ContentType "application/json" -Headers $H -Body (@{roleId=$role.id} | ConvertTo-Json) | Out-Null
Write-Host "== authorize =="
$a = Invoke-RestMethod -Method Post "$Base/v1/authorize" -ContentType "application/json" -Headers $H -Body (@{userId=$uid; action='workflow:Execute'; resource='*'} | ConvertTo-Json)
Write-Host ("allowed=" + $a.allowed)
Write-Host "== api key =="
$k = Invoke-RestMethod -Method Post "$Base/v1/accounts/$($acc.id)/keys" -ContentType "application/json" -Headers $H -Body '{"name":"demo","scopes":["*"]}'
Write-Host ("prefix=" + $k.prefix + " (lưu apiKey ngay, chỉ hiện 1 lần)")
Write-Host "== templates =="
Invoke-RestMethod "$Base/v1/templates" -Headers $H | ConvertTo-Json -Depth 3
