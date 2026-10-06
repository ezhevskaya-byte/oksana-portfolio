# LIVE retest 8 dialogues via Invoke-WebRequest (stable on this host)
$ErrorActionPreference = "Continue"
$API = "https://smart-brief-api-test.ezhevskaya.workers.dev/api/chat"
$ORIGIN = "https://ezhevskaya.ru"
$OutJson = Join-Path $PSScriptRoot "_live-retest-8-out.json"
$utf8 = New-Object System.Text.UTF8Encoding $false

function Invoke-Chat($sessionId, $message, $history, $briefState) {
  $payload = @{
    sessionId = $sessionId
    message = $message
    history = @($history)
    briefState = $briefState
  }
  $json = $payload | ConvertTo-Json -Compress -Depth 20
  $bytes = $utf8.GetBytes($json)
  for ($attempt = 1; $attempt -le 6; $attempt++) {
    try {
      $resp = Invoke-WebRequest -Uri $API -Method POST -ContentType "application/json; charset=utf-8" `
        -Headers @{ Origin = $ORIGIN } -Body $bytes -TimeoutSec 120
      $text = $utf8.GetString($resp.RawContentStream.ToArray())
      if ([string]::IsNullOrWhiteSpace($text)) { $text = $resp.Content }
      return ($text | ConvertFrom-Json)
    } catch {
      Write-Host "retry $attempt $($_.Exception.Message)"
      Start-Sleep -Seconds (2 * $attempt)
    }
  }
  return @{ ok = $false; error = "fetch_failed"; assistantMessage = ""; phase = "" }
}

function Pick-Answer($mark, $bank, $used) {
  $t = [string]$mark
  $tLower = $t.ToLowerInvariant()
  $key = "default"
  if ($tLower -match "чем\s+именно|о\s+вашем\s+бизнесе|что\s+предлагаете|какой\s+у\s+вас\s+бизнес") { $key = "business" }
  elseif ($tLower -match "какого\s+результата|что\s+должно\s+измениться") { $key = "goal" }
  elseif ($tLower -match "кто\s+(?:чаще|обычно)|основные|останавливается") { $key = "who" }
  elseif ($tLower -match "важнее|при\s+выборе|обращают\s+внимание|что\s+важно") { $key = "matters" }
  elseif ($tLower -match "следующий\s+шаг|как\s+обычно\s+проходит|что\s+происходит\s+дальше") { $key = "journey" }
  elseif ($tLower -match "теряется\s+время|где\s+сейчас\s+больше") { $key = "friction" }
  elseif ($tLower -match "помимо|таблиц|crm|календар") { $key = "tools" }
  elseif ($tLower -match "как\s+бы\s+вы\s+хотели|в\s+идеале") { $key = "flow" }
  elseif ($tLower -match "оплат|предоплат|стабильн|расписан|собрать\s+обращение|одинаков") { $key = "disc" }

  foreach ($poolKey in @($key, "disc", "default")) {
    if (-not $bank.ContainsKey($poolKey)) { continue }
    foreach ($a in $bank[$poolKey]) {
      if (-not $used.ContainsKey($a)) {
        $used[$a] = $true
        return $a
      }
    }
  }
  return "Могу уточнить: почти всё вручную, хочу спокойнее принимать обращения."
}

$scenarios = @(
  @{
    id = "L1_lodging_sea_flats"; domain = "lodging"
    open = "Сдаём три квартиры у набережной посуточно. Гости пишут из Авито и Telegram, даты я подтверждаю вручную."
    answers = @{
      business = @("Это посуточная аренда трёх квартир у моря, заселение и уборка на нас.")
      goal = @("Хочу, чтобы гости сами видели свободные даты и меньше писали одно и то же про заезд.")
      who = @("Обычно пары и семьи на 2–5 ночей.")
      matters = @("Им важны чистота, вид из окна, понятные фото и сразу ясная цена с датами.")
      journey = @("Смотрят объявление, пишут в Telegram, я сверяю календарь, называю сумму, беру предоплату и подтверждаю.")
      friction = @("Вечера уходят на повторные ответы про наличие дат.")
      tools = @("Календарь в таблице и Telegram. Отдельного модуля бронирования нет.")
      flow = @("Пусть гость сам выбирает даты и оставляет бронь, а я только подтверждаю.")
      disc = @("Предоплата нужна. В сезон занятость скачет почти каждый день.")
      default = @("Почти всё вручную, хочу упростить первый контакт.")
    }
  },
  @{
    id = "L2_lodging_guest_house"; domain = "lodging"
    open = "Держим небольшой гостевой дом на 6 номеров. Бронь сейчас собираю в WhatsApp и Excel."
    answers = @{
      business = @("Гостевой дом: ночлег, завтрак по запросу, заселение лично.")
      goal = @("Нужно сократить ручные подтверждения дат и предоплаты.")
      who = @("Чаще семьи с детьми и небольшие компании друзей.")
      matters = @("Гостям важны тишина, парковка, расстояние до пляжа и прозрачные условия отмены.")
      journey = @("Пишут в WhatsApp, спрашивают даты, я смотрю Excel, отвечаю по цене, жду перевод и подтверждаю.")
      friction = @("Путаюсь, какой номер кому обещала, пока всё в чатах.")
      tools = @("WhatsApp и Excel. Сайта почти нет.")
      flow = @("Хочу календарь занятости и заявку с датами без долгой переписки.")
      disc = @("Предоплата обязательна. Цены в высокий сезон меняем часто.")
      default = @("Почти всё вручную, хочу упростить бронь.")
    }
  },
  @{
    id = "B1_b2b_tax"; domain = "professional/B2B"
    open = "Я консультирую небольшие компании по налогам и отчётности. Обычно ко мне приходят по рекомендации и пишут в Telegram."
    answers = @{
      business = @("Налоговое сопровождение малого бизнеса: отчётность, режимы, проверки.")
      goal = @("Хочу тратить меньше времени на повторные объяснения услуг и входных данных.")
      who = @("Собственники ООО и ИП, иногда главбухи.")
      matters = @("Им важны скорость ответа, понятный состав услуги и вилка цены.")
      journey = @("Пишут в Telegram коротко про задачу, я уточняю форму и режим, называю ориентир, потом договор.")
      friction = @("Одни и те же пояснения в каждой новой переписке.")
      tools = @("Telegram и заметки. CRM нет.")
      flow = @("Человек сначала читает, что я беру, отвечает на вопросы о бизнесе, и я понимаю, подходит ли кейс.")
      disc = @("Вопросы к клиенту почти одинаковые. После сбора почти всегда нужен короткий созвон. Оплата по договору, онлайн не нужна.")
      default = @("Сейчас всё на ручной переписке.")
    }
  },
  @{
    id = "B2_b2b_hr"; domain = "professional/B2B"
    open = "Помогаю компаниям с кадровым учётом и оформлением сотрудников. Заявки приходят из рекомендаций в WhatsApp."
    answers = @{
      business = @("Кадровый консалтинг и ведение кадров для малого бизнеса.")
      goal = @("Нужен спокойный вход: меньше переписывать одно и то же про пакет услуг.")
      who = @("Директора маленьких компаний и иногда бухгалтеры.")
      matters = @("Важно, что я закрываю сроки отчётности и объясняю просто.")
      journey = @("Пишут в WhatsApp, я уточняю численность и задачи, даю оценку, потом договор.")
      friction = @("Много времени на первичную квалификацию.")
      tools = @("WhatsApp и Google-таблица клиентов.")
      flow = @("Хочу короткую анкету до созвона: численность, задачи, сроки.")
      disc = @("Набор вопросов похож. Созвон почти всегда нужен. Онлайн-оплата не требуется.")
      default = @("Хочу спокойнее принимать обращения.")
    }
  },
  @{
    id = "S1_studio_yoga"; domain = "studio"
    open = "Веду небольшую йога-студию. Люди находят нас в Instagram, администратор записывает вручную в переписке."
    answers = @{
      business = @("Студия йоги: групповые и персональные занятия по расписанию.")
      goal = @("Упростить запись: меньше ручных ответов про время и места.")
      who = @("В основном женщины 25–40 лет.")
      matters = @("Им важны удобный слот, атмосфера и быстрый ответ.")
      journey = @("Пишут в Direct, админ смотрит таблицу и записывает.")
      friction = @("Однотипные вопросы про расписание съедают день.")
      tools = @("Google-таблица и календарь. Онлайн-записи нет.")
      flow = @("Человек сам видит расписание и записывается.")
      disc = @("Онлайн-оплата не обязательна. Расписание меняется, несколько инструкторов, места ограничены.")
      default = @("Главное — снять ручную координацию слотов.")
    }
  },
  @{
    id = "G1_bike_service"; domain = "generic service"
    open = "Мастерская по ремонту велосипедов. Клиенты пишут в WhatsApp или заходят с улицы, очередь веду в блокноте."
    answers = @{
      business = @("Ремонт и ТО велосипедов, городские райдеры и родители.")
      goal = @("Меньше хаоса: кто на когда записан и что чинить.")
      who = @("Городские велосипедисты 20–45 лет.")
      matters = @("Срок готовности, понятная цена, чтобы велик не потерялся в очереди.")
      journey = @("Описывают поломку, я называю срок и цену, пишу в блокнот, ремонтирую, отдаю.")
      friction = @("Постоянные «ну что там с моим?».")
      tools = @("WhatsApp и блокнот. Сайта нет.")
      flow = @("Заявка с описанием и удобным днём, очередь в одном месте.")
      disc = @("Оплата на месте, онлайн не нужна. Поток ровный.")
      default = @("Нужен спокойный приём заявок без блокнота.")
    }
  },
  @{
    id = "E1_tutor_math"; domain = "education"
    open = "Готовлю школьников к контрольным по математике. Родители пишут в WhatsApp, я сама не уверена: сайт, бот или что-то проще."
    answers = @{
      business = @("Репетитор математики 5–9 класс, индивидуальные занятия.")
      goal = @("До переписки было ясно, с кем работаю и как проходит занятие, заявка уже с вводными.")
      who = @("Родители детей 5–9 класса.")
      matters = @("Спокойный темп, понятная цена, чтобы ребёнку не было страшно ошибаться.")
      journey = @("Пишут в WhatsApp, уточняю класс и цели, подбираю время, начинаем.")
      friction = @("Каждому заново объясняю формат и цены.")
      tools = @("WhatsApp и таблица учеников.")
      flow = @("Родитель сам смотрит, кому подхожу, выбирает слот пробного и пишет задачу ребёнка.")
      disc = @("Оплата после пробного. Расписание стабильное, веду сама.")
      default = @("Не хочу сложную систему.")
    }
  },
  @{
    id = "U1_mixed_unclear"; domain = "unknown/mixed"
    open = "Делаю торты на заказ для семейных праздников. Заказы в Instagram Direct, иногда путаюсь в датах и начинках."
    answers = @{
      business = @("Домашняя кондитерская: торты на заказ к датам.")
      goal = @("Хочу, чтобы заказ приходил уже с датой, числом порций и пожеланиями по вкусу.")
      who = @("Чаще мамы к дням рождения детей и пары к годовщинам.")
      matters = @("Важно успеть к дате, понятный состав и адекватная цена.")
      journey = @("Пишут в Direct, обсуждаем начинку и дату, я пеку, забирают или доставка.")
      friction = @("Много уточнений в чате и риск перепутать дату.")
      tools = @("Instagram и блокнот заказов.")
      flow = @("Короткая форма заказа с датой и начинкой до переписки.")
      disc = @("Предоплата частичная удобна. Поток неровный к праздникам.")
      default = @("Хочу меньше путаницы в заказах.")
    }
  }
)

function Analyze-Result($result) {
  $notes = New-Object System.Collections.Generic.List[string]
  $verdict = "PASS"
  $clarifies = @($result.transcript | Where-Object { $_.role -eq "mark" -and $_.phase -ne "recommend" -and $_.phase -ne "handoff" })
  if ($result.ended -ne "recommend") {
    $notes.Add("Не дошли до recommendation: $($result.ended)")
    $verdict = "FAIL"
  }
  $mattersAsks = 0; $whoAsks = 0; $businessAsks = 0
  $seen = @{}
  foreach ($c in $clarifies) {
    $t = [string]$c.text
    $n = ($t.ToLowerInvariant() -replace "\s+", " ").Trim()
    if ($seen.ContainsKey($n)) {
      $notes.Add("Exact clarify repeat")
      $verdict = "FAIL"
    }
    $seen[$n] = $true
    if ($t -match "важн|при выборе|обращают внимание" -and $t -match "гост|клиент|ученик|них|этих") { $mattersAsks++ }
    if ($t -match "кто\s+(чаще|обычно)|основные|останавливается") { $whoAsks++ }
    if ($t -match "о вашем бизнесе|чем именно вы занимаетесь|что предлагаете") { $businessAsks++ }
  }
  if ($mattersAsks -gt 1) { $notes.Add("HARD: what_matters asked $mattersAsks times"); $verdict = "FAIL" }
  if ($whoAsks -gt 1) { $notes.Add("HARD: WHO asked $whoAsks times"); $verdict = "FAIL" }
  $open = ""
  if ($result.transcript.Count -gt 0) { $open = [string]$result.transcript[0].text }
  if ($businessAsks -gt 0 -and $open -match "консультир|сда|студи|мастерск|репетитор|квартир|гостев|кадров|йог|торт") {
    $notes.Add("BUSINESS re-ask after open evidence")
    if ($verdict -eq "PASS") { $verdict = "SOFT ISSUE" }
  }
  $blob = (($result.transcript | Where-Object { $_.role -eq "mark" } | ForEach-Object { $_.text }) -join "`n")
  if ($result.domain -notmatch "lodging" -and $blob -match "(^|[^а-яё])гост(ь|я|ю|ем|и|ей)\b" -and $blob -notmatch "гостев") {
    $notes.Add("Possible guest domain leak")
    if ($verdict -ne "FAIL") { $verdict = "SOFT ISSUE" }
  }
  if ($blob -match "договор" -and $result.domain -notmatch "b2b|B2B|professional") {
    $notes.Add("Ungrounded договор in non-B2B")
    if ($verdict -eq "PASS") { $verdict = "SOFT ISSUE" }
  }
  if ($result.recommend -match "не удалось безопасно") {
    $notes.Add("READY_FALLBACK"); $verdict = "FAIL"
  }
  return @{ verdict = $verdict; notes = $notes.ToArray() }
}

$results = @()
foreach ($sc in $scenarios) {
  Write-Host "Running $($sc.id) ..."
  $sid = "live8-$($sc.id)-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
  $history = @()
  $briefState = $null
  $message = $sc.open
  $used = @{}
  $transcript = New-Object System.Collections.Generic.List[object]
  $recommend = $null
  $ended = "no_recommend"

  for ($turn = 0; $turn -lt 14; $turn++) {
    if ($turn -gt 0) { Start-Sleep -Milliseconds 900 }
    $p = Invoke-Chat $sid $message $history $briefState
    $mark = [string]$p.assistantMessage
    $phase = [string]$p.phase
    $transcript.Add([pscustomobject]@{ role = "user"; text = $message })
    $transcript.Add([pscustomobject]@{ role = "mark"; text = $mark; phase = $phase; ok = ($p.ok -ne $false) })

    if ($p.ok -eq $false -or [string]::IsNullOrWhiteSpace($mark)) {
      $ended = "error"
      break
    }

    $history += @(@{ role = "user"; content = $message }, @{ role = "assistant"; content = $mark })
    if ($null -ne $p.briefState) { $briefState = $p.briefState }

    if ($phase -eq "recommend" -or $phase -eq "handoff") {
      $recommend = $mark
      $ended = "recommend"
      break
    }
    $message = Pick-Answer $mark $sc.answers $used
  }

  $obj = [pscustomobject]@{
    id = $sc.id
    domain = $sc.domain
    transcript = $transcript
    recommend = $recommend
    ended = $ended
  }
  $analysis = Analyze-Result $obj
  $obj | Add-Member -NotePropertyName analysis -NotePropertyValue $analysis
  $results += $obj
  Write-Host "  -> $ended / $($analysis.verdict)"
  Start-Sleep -Seconds 2
}

$results | ConvertTo-Json -Depth 30 | Set-Content -Path $OutJson -Encoding UTF8
$summary = $results | ForEach-Object {
  [pscustomobject]@{
    id = $_.id
    domain = $_.domain
    ended = $_.ended
    verdict = $_.analysis.verdict
    notes = ($_.analysis.notes -join "; ")
    recommendPreview = if ($_.recommend) { $_.recommend.Substring(0, [Math]::Min(200, $_.recommend.Length)) } else { "" }
  }
}
$summary | ConvertTo-Json -Depth 5
Write-Host "DONE"
