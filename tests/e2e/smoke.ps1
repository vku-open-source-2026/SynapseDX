#RequiresVersion 5.1
# OLP e2e smoke cho Windows PowerShell
param([string]$Base = $env:OLP_BASE_URL)
if (-not $Base) { $Base = "http://localhost:8080" }
$Iam = "http://localhost:4001"
$pass = 0; $fail = 0
function Check($name, [scriptblock]$sb) {
  try { & $sb | Out-Null; Write-Host "PASS $name"; $script:pass++ } catch { Write-Host "FAIL $name : $_"; $script:fail++ }
}
Write-Host "== OLP smoke vs $Base =="
Check "gateway-health" { Invoke-RestMethod "$Base/health" -TimeoutSec 10 }
Check "iam-health" { Invoke-RestMethod "$Iam/health" -TimeoutSec 10 }
try {
  $login = Invoke-RestMethod -Method Post "$Base/v1/auth/login" -ContentType "application/json" -Body '{"email":"smoke@acme.local","orgSlug":"acme"}' -TimeoutSec 15
  if ($login.accessToken) { Write-Host "PASS login"; $pass++ } else { Write-Host "FAIL login"; $fail++ }
  $tok = $login.accessToken
  if ($tok) {
    Check "orgs-list" { Invoke-RestMethod "$Base/v1/orgs" -Headers @{ Authorization = "Bearer $tok" } -TimeoutSec 10 }
    Check "templates" { Invoke-RestMethod "$Base/v1/templates" -Headers @{ Authorization = "Bearer $tok" } -TimeoutSec 10 }
  }
} catch { Write-Host "FAIL login : $_"; $fail++ }
Write-Host "== result: pass=$pass fail=$fail =="
if ($fail -gt 0) { exit 1 }
