# PowerShell test of the Autoline API (no Node needed)
# Run:  powershell -ExecutionPolicy Bypass -File scripts\test-autoline.ps1 NKUHD65SLEDT
param([string]$PartNumber = "NKUHD65SLEDT", [string]$RooftopId = "SO01P_PH")

$body = @{ SessionId = 12345; RooftopId = $RooftopId; UserId = "ADMIN-YK"; PartNumber = $PartNumber } | ConvertTo-Json
$r = Invoke-RestMethod -Method Post `
  -Uri "https://ykacentralapi.almoayyed.com.bh/prod/api/v1/parts/LoadPartsStockRecord" `
  -ContentType "application/json" -Body $body
$r | ConvertTo-Json -Depth 5
