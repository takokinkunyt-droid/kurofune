# ============================================================
#  黒船クリッカー 補填スクリプト（PowerShell）
#
#  ※ exit を使っていません。コンソールに貼り付けても窓は閉じません。
#
#  使い方
#    1. 下の $secret と $domain を書き換える
#    2. PowerShell でこのファイルがある場所へ移動
#    3.  .\compensate.ps1
#
#  何をするか
#    ・名前から playerId を引く（確認のため一覧を表示）
#    ・「武蔵野東中学校」    … 隻数を 1e15 に戻す＋「持ち越し」を付与
#    ・「INMU KING」        … 補填一式を渡す（サブ垢への移管）
#    ・施設・実績・プレイヤー名には一切触れない
#    ・実行前に必ず内容を表示し、y を入れないと送信しない
# ============================================================

$secret = 'ここにADMIN_SECRET'
$domain = 'https://ここにドメイン'

# ---- 補填内容 ------------------------------------------------
# 既存アカウント：隻数を戻すだけ。かけらは超転生で正当に増えた分なので触らない。
$patchMusashino = @{
  clickerScore = 1e15
  superSkills  = @{ carryOver = $true }
}

# 新規サブ垢：最初の補填一式。
# 施設のロックは skills から自動で再計算されるので指定不要。
$patchInmuKing = @{
  clickerScore            = 1e15
  reincarnationCount      = 10
  superReincarnationCount = 1
  fragments               = 10000
  sakokuShards            = 500
  skills = @{
    dawn = $true; modShip = $true; rebellion = $true; modernization = $true
    addBase1 = $true; addBase2 = $true
    kakera1 = $true; kakera2 = $true; kakera3 = $true
    senpan = $true; senpanKill = $true; achievementBoost = $true
    keiyaku = $true; kaikoku = $true; ifSkill = $true
  }
  superSkills = @{ root = $true; carryOver = $true }
}
# --------------------------------------------------------------

function Invoke-Api($path, $bodyObj) {
  $json  = $bodyObj | ConvertTo-Json -Depth 10 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-RestMethod -Uri "$domain/api/$path" -Method Post `
           -ContentType 'application/json' -Body $bytes
}

function Find-Player($name) {
  $u = "$domain/api/restore-save?action=whois&secret=$([uri]::EscapeDataString($secret))&name=$([uri]::EscapeDataString($name))"
  try { return (Invoke-RestMethod -Uri $u).hits } catch { Write-Host "検索失敗: $name  $_" -ForegroundColor Red; return @() }
}

# ---- 0. 鍵の確認 ---------------------------------------------
$st = Invoke-RestMethod -Uri "$domain/api/restore-save?action=status"
if (-not $st.adminSecretConfigured) {
  Write-Host "ADMIN_SECRET が未設定です。Vercel に設定して Redeploy してください。" -ForegroundColor Red
  Read-Host '何かキーを押すと終了します'
  return
}
Write-Host "ADMIN_SECRET 設定済み（$($st.secretLength) 文字）`n" -ForegroundColor Green

# ---- 1. ID を引く --------------------------------------------
$targets = @()
foreach ($pair in @(
    @{ name = '武蔵野東中学校'; set = $patchMusashino; label = '隻数を戻す' },
    @{ name = 'INMU KING';     set = $patchInmuKing;  label = '補填一式を渡す' })) {

  $hits = @(Find-Player $pair.name | Where-Object { $_.exact })
  if ($hits.Count -eq 0) { Write-Host "見つかりません: $($pair.name)" -ForegroundColor Red; continue }
  if ($hits.Count -gt 1) { Write-Host "同名が複数います: $($pair.name)" -ForegroundColor Red; $hits | Format-Table; continue }

  $h = $hits[0]
  Write-Host ("[{0}] {1}" -f $pair.label, $h.playerName)
  Write-Host ("   playerId : {0}" -f $h.playerId)
  Write-Host ("   現在     : {0} 隻 / 転生 {1} / かけら {2}" -f $h.clickerScore, $h.reincarnationCount, $h.fragments)
  Write-Host ("   変更後   : {0}" -f (($pair.set.GetEnumerator() | ForEach-Object { "$($_.Key)" }) -join ', '))
  Write-Host ""
  $targets += @{ playerId = $h.playerId; name = $h.playerName; set = $pair.set }
}

if ($targets.Count -eq 0) { Write-Host "対象がありません。中止します。" -ForegroundColor Red; Read-Host "何かキーを押すと終了します"; return }

# ---- 2. 確認 -------------------------------------------------
$ans = Read-Host "この $($targets.Count) 件を実行しますか？ (y/n)"
if ($ans -ne 'y') { Write-Host "中止しました。" -ForegroundColor Yellow; Read-Host "何かキーを押すと終了します"; return }

# ---- 3. 実行 -------------------------------------------------
foreach ($t in $targets) {
  Write-Host "`n--- $($t.name) ---"
  try {
    $r = Invoke-Api 'restore-save' @{
      secret   = $secret
      playerId = $t.playerId
      action   = 'patch'
      set      = $t.set
    }
    Write-Host "成功" -ForegroundColor Green
    $r.restored | Format-List
  } catch {
    Write-Host "失敗: $_" -ForegroundColor Red
    # CARRYOVER_TRAP が返った場合は superSkills.carryOver の指定漏れ
  }
}

Write-Host "`n完了しました。本人にページの再読み込みを伝えてください。" -ForegroundColor Cyan
Write-Host "書き換える前の状態は履歴に積まれているので、やり直せます。"
Write-Host "  $domain/api/restore-save?playerId=<ID>&action=list"

Read-Host "`n何かキーを押すと終了します"
