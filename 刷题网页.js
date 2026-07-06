const CONFIG = {
  paperModes: {
    practice: { label: "练习模式", singleCount: 15, multipleCount: 25, source: "current" },
    exam: { label: "考试模式", singleCount: 80, multipleCount: 20, source: "all" },
    wrong: { label: "错题重刷", singleCount: 15, multipleCount: 25, source: "wrong", allowPartial: true },
  },
  wrongStorageKey: "xigaiQuizWrongQuestions:v1",
  manifestPaths: [
    new URL("题库列表.json", window.location.href).href,
    "./题库列表.json",
    "http://127.0.0.1:8765/%E9%A2%98%E5%BA%93%E5%88%97%E8%A1%A8.json",
    "http://localhost:8765/%E9%A2%98%E5%BA%93%E5%88%97%E8%A1%A8.json",
  ],
  fallbackBanks: [{ id: "bank1", name: "题库1", path: "题库.import.json" }],
};

const state = {
  banks: [],
  verifiedAnalyses: [],
  activeBank: null,
  bank: [],
  allBank: [],
  wrongRecords: {},
  paperWrongRecordedKeys: new Set(),
  bankWrongRecordedKeys: new Set(),
  bankShuffled: false,
  bankShuffleOrder: [],
  bankChecked: false,
  bankRenderedQuestions: [],
  bankOptionVariants: new Map(),
  paper: [],
  mode: "practice",
  paperMode: "practice",
  checked: false,
  answersVisible: false,
  bankAnswersVisible: false,
};

const els = {
  bankMeta: document.querySelector("#bankMeta"),
  loadingState: document.querySelector("#loadingState"),
  paperRoot: document.querySelector("#paperRoot"),
  bankRoot: document.querySelector("#bankRoot"),
  bankList: document.querySelector("#bankList"),
  bankSelect: document.querySelector("#bankSelect"),
  bankSearch: document.querySelector("#bankSearch"),
  bankTypeFilter: document.querySelector("#bankTypeFilter"),
  bankViewBtn: document.querySelector("#bankViewBtn"),
  bankAnswerToggle: document.querySelector("#bankAnswerToggle"),
  bankShuffleToggle: document.querySelector("#bankShuffleToggle"),
  bankCheckBtn: document.querySelector("#bankCheckBtn"),
  bankResetBtn: document.querySelector("#bankResetBtn"),
  paperModeButtons: document.querySelectorAll("[data-paper-mode]"),
  wrongReviewBtn: document.querySelector("#wrongReviewBtn"),
  clearWrongBtn: document.querySelector("#clearWrongBtn"),
  wrongBadge: document.querySelector("#wrongBadge"),
  newPaperBtn: document.querySelector("#newPaperBtn"),
  checkBtn: document.querySelector("#checkBtn"),
  answerBtn: document.querySelector("#answerBtn"),
  scoreLabel: document.querySelector("#scoreLabel"),
  scoreValue: document.querySelector("#scoreValue"),
  answeredLabel: document.querySelector("#answeredLabel"),
  singleCount: document.querySelector("#singleCount"),
  multipleCount: document.querySelector("#multipleCount"),
  answeredCount: document.querySelector("#answeredCount"),
  correctCount: document.querySelector("#correctCount"),
  progressFill: document.querySelector("#progressFill"),
  statusText: document.querySelector("#statusText"),
  template: document.querySelector("#questionTemplate"),
};

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
  }
  return copy;
}

function normalizeAnswer(answer) {
  return [...answer].sort().join("");
}

function getQuestionAnswer(questionId) {
  return [...document.querySelectorAll(`[name="${questionId}"]:checked`)].map((input) => input.value).sort();
}

function isAnswered(question) {
  return getQuestionAnswer(inputName(question)).length > 0;
}

function isCorrect(question) {
  return normalizeAnswer(getQuestionAnswer(inputName(question))) === normalizeAnswer(question.answer);
}

function getBankQuestionAnswer(question) {
  return [...document.querySelectorAll(`[name="${bankInputName(question)}"]:checked`)].map((input) => input.value).sort();
}

function isBankQuestionAnswered(question) {
  return getBankQuestionAnswer(question).length > 0;
}

function isBankQuestionCorrect(question) {
  return normalizeAnswer(getBankQuestionAnswer(question)) === normalizeAnswer(question.answer);
}

function inputName(question) {
  return `q-${question.runtimeId || question.id}`;
}

function bankInputName(question) {
  return `bank-${question.sourceBankId || state.activeBank?.id || "bank"}-${question.id}`;
}

function optionEntries(question) {
  return Object.entries(question.options).sort(([left], [right]) => left.localeCompare(right));
}

function getPaperModeConfig() {
  return CONFIG.paperModes[state.paperMode] || CONFIG.paperModes.practice;
}

function getPaperSource() {
  const config = getPaperModeConfig();
  if (config.source === "all") {
    return state.allBank;
  }
  if (config.source === "wrong") {
    return getWrongPool();
  }
  return state.bank;
}

function randomizeQuestionOptions(question) {
  const optionKeys = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const entries = shuffle(optionEntries(question));
  const keyMap = new Map();
  const options = {};

  entries.forEach(([oldKey, text], index) => {
    const newKey = optionKeys[index] || oldKey;
    keyMap.set(oldKey, newKey);
    options[newKey] = text;
  });

  const answer = question.answer.map((key) => keyMap.get(key)).filter(Boolean).sort();
  const answerText = answer.map((key) => options[key]).filter(Boolean);

  return {
    ...question,
    options,
    answer,
    answer_text: answerText,
    analysis: remapAnalysisOptions(question.analysis, keyMap),
  };
}

function remapAnalysisOptions(analysis, keyMap) {
  if (!analysis || typeof analysis === "string") {
    return analysis;
  }
  const remappedOptions = {};
  Object.entries(analysis.options || {}).forEach(([oldKey, text]) => {
    const newKey = keyMap.get(oldKey);
    if (newKey) {
      remappedOptions[newKey] = text;
    }
  });

  return {
    ...analysis,
    options: remappedOptions,
  };
}

function normalizeLookupText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/【[^】]*】/g, "")
    .replace(/[（(]\s*[）)]/g, "()")
    .replace(/[^\p{Letter}\p{Number}_]+/gu, "")
    .toLowerCase();
}

function applyVerifiedAnalyses(bank) {
  if (!Array.isArray(state.verifiedAnalyses) || state.verifiedAnalyses.length === 0) {
    return bank;
  }
  const overrides = new Map();
  state.verifiedAnalyses
    .filter((item) => item && item.verified === true)
    .forEach((item) => {
      const key = normalizeLookupText(item.question);
      const candidates = overrides.get(key) || [];
      candidates.push(item);
      overrides.set(key, candidates);
    });

  return bank.map((question) => {
    const candidates = overrides.get(normalizeLookupText(question.question));
    if (!candidates || candidates.length === 0) {
      return question;
    }
    const match = candidates
      .map((override) => ({ override, options: buildVerifiedOptionMap(question, override) }))
      .find((candidate) => candidate.options);
    if (!match) {
      return question;
    }
    return {
      ...question,
      analysis: {
        verified: true,
        summary: match.override.summary,
        options: match.options,
        sources: match.override.sources || [],
      },
    };
  });
}

function buildVerifiedOptionMap(question, override) {
  const questionOptions = Object.entries(question.options);
  const overrideOptions = Object.entries(override.options || {});
  if (overrideOptions.length !== questionOptions.length) {
    return null;
  }

  const optionByText = new Map(questionOptions.map(([key, text]) => [normalizeLookupText(text), key]));
  const options = {};
  for (const [optionText, explanation] of overrideOptions) {
    const key = optionByText.get(normalizeLookupText(optionText));
    if (!key) {
      return null;
    }
    options[key] = explanation;
  }

  return Object.keys(options).length === questionOptions.length ? options : null;
}

function questionFingerprint(question) {
  const options = Object.values(question.options || {}).map(normalizeLookupText).sort();
  return [question.type, normalizeLookupText(question.question), ...options].join("|");
}

function dedupeQuestions(questions) {
  const seen = new Set();
  const unique = [];
  questions.forEach((question) => {
    const key = questionFingerprint(question);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    unique.push(question);
  });
  return unique;
}

function loadWrongRecords() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG.wrongStorageKey) || "{}");
    state.wrongRecords = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  } catch {
    state.wrongRecords = {};
  }
}

function saveWrongRecords() {
  try {
    localStorage.setItem(CONFIG.wrongStorageKey, JSON.stringify(state.wrongRecords));
  } catch {
    // localStorage can be unavailable in some private browsing modes.
  }
  updateWrongControls();
}

function wrongRecordKey(question) {
  return questionFingerprint(question);
}

function serializeWrongQuestion(question) {
  return {
    id: question.id,
    type: question.type,
    type_label: question.type_label,
    question: question.question,
    options: question.options,
    answer: question.answer,
    answer_text: question.answer_text,
    analysis: question.analysis,
    sourceBankId: question.sourceBankId,
    sourceBankName: question.sourceBankName,
  };
}

function getWrongCount() {
  return Object.keys(state.wrongRecords).length;
}

function getWrongPool() {
  const allByKey = new Map(state.allBank.map((question) => [wrongRecordKey(question), question]));
  return Object.values(state.wrongRecords)
    .map((record) => allByKey.get(record.key) || record.question)
    .filter(Boolean);
}

function getWrongRecord(question) {
  return state.wrongRecords[wrongRecordKey(question)];
}

function wrongCountText(question) {
  const count = getWrongRecord(question)?.wrongCount || 0;
  return count > 0 ? `错 ${count} 次` : "";
}

function addWrongRecord(question) {
  const key = wrongRecordKey(question);
  const previous = state.wrongRecords[key];
  state.wrongRecords[key] = {
    key,
    question: serializeWrongQuestion(question),
    wrongCount: (previous?.wrongCount || 0) + 1,
    firstWrongAt: previous?.firstWrongAt || new Date().toISOString(),
    lastWrongAt: new Date().toISOString(),
  };
}

function removeWrongRecord(question) {
  delete state.wrongRecords[wrongRecordKey(question)];
}

function updateWrongRecordForQuestion(question) {
  const key = wrongRecordKey(question);
  if (isCorrect(question)) {
    removeWrongRecord(question);
    state.paperWrongRecordedKeys.delete(key);
    return;
  }
  if (!state.paperWrongRecordedKeys.has(key)) {
    addWrongRecord(question);
    state.paperWrongRecordedKeys.add(key);
  }
}

function updateWrongRecordsFromPaper() {
  state.paper.forEach(updateWrongRecordForQuestion);
  saveWrongRecords();
}

function updateWrongRecordForBankQuestion(question) {
  const key = wrongRecordKey(question);
  if (!isBankQuestionAnswered(question)) {
    return;
  }
  if (isBankQuestionCorrect(question)) {
    removeWrongRecord(question);
    state.bankWrongRecordedKeys.delete(key);
    return;
  }
  if (!state.bankWrongRecordedKeys.has(key)) {
    addWrongRecord(question);
    state.bankWrongRecordedKeys.add(key);
  }
}

function updateWrongRecordsFromBank() {
  state.bankRenderedQuestions.forEach(updateWrongRecordForBankQuestion);
  saveWrongRecords();
}

function updateWrongControls() {
  const count = getWrongCount();
  if (els.wrongBadge) {
    els.wrongBadge.textContent = String(count);
  }
  if (els.wrongReviewBtn) {
    els.wrongReviewBtn.disabled = count === 0;
    els.wrongReviewBtn.title = count === 0 ? "交卷后答错的题会加入错题本" : `重刷 ${count} 道错题`;
  }
  if (els.clearWrongBtn) {
    els.clearWrongBtn.disabled = count === 0;
  }
}

function drawPaper() {
  const config = getPaperModeConfig();
  const sourceBank = getPaperSource();
  const singles = sourceBank.filter((item) => item.type === "single");
  const multiples = sourceBank.filter((item) => item.type === "multiple");
  const singleCount = config.allowPartial ? Math.min(config.singleCount, singles.length) : config.singleCount;
  const multipleCount = config.allowPartial ? Math.min(config.multipleCount, multiples.length) : config.multipleCount;

  if (config.source === "wrong" && sourceBank.length === 0) {
    state.paperMode = "practice";
    updatePaperModeControls();
    updateWrongControls();
    drawPaper();
    els.statusText.textContent = "暂无错题，已返回练习模式。交卷判分后，答错或未答的题会自动加入错题本。";
    return;
  }

  if (singles.length < singleCount || multiples.length < multipleCount) {
    throw new Error(`${config.label}题库数量不足：单选 ${singles.length}/${singleCount}，多选 ${multiples.length}/${multipleCount}`);
  }

  state.paper = [
    ...shuffle(singles).slice(0, singleCount),
    ...shuffle(multiples).slice(0, multipleCount),
  ].map((question, index) =>
    randomizeQuestionOptions({
      ...question,
      runtimeId: `${state.paperMode}-${index}-${question.sourceBankId || state.activeBank?.id || "bank"}-${question.id}`,
    })
  );
  state.checked = false;
  state.answersVisible = false;
  state.paperWrongRecordedKeys = new Set();
  setMode("practice");
  renderPaper();
  updateSummary();
}

function buildPathCandidates(path) {
  if (/^https?:\/\//i.test(path)) {
    return [path];
  }
  const encodedPath = path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return [
    new URL(encodedPath, window.location.href).href,
    path.startsWith("./") ? path : `./${path}`,
    `http://127.0.0.1:8765/${encodedPath}`,
    `http://localhost:8765/${encodedPath}`,
  ];
}

async function fetchFirstJson(paths) {
  let lastError = null;
  for (const path of paths) {
    try {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`${path} 返回 ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("无法读取 JSON");
}

async function loadBankManifest() {
  let banks = null;
  try {
    banks = await fetchFirstJson(CONFIG.manifestPaths);
  } catch {
    banks = CONFIG.fallbackBanks;
  }

  if (!Array.isArray(banks) || banks.length === 0) {
    throw new Error("题库列表格式错误");
  }

  state.banks = banks.map((bank, index) => ({
    id: String(bank.id || `bank${index + 1}`),
    name: String(bank.name || `题库${index + 1}`),
    path: String(bank.path || ""),
  }));
  renderBankSelector();
}

async function loadVerifiedAnalyses() {
  try {
    const data = await fetchFirstJson(buildPathCandidates("联网核验解析.json"));
    state.verifiedAnalyses = Array.isArray(data) ? data : [];
  } catch {
    state.verifiedAnalyses = [];
  }
}

async function loadAllBanks() {
  const loadedBanks = await Promise.all(
    state.banks.map(async (bank) => {
      const data = await fetchFirstJson(buildPathCandidates(bank.path));
      if (!Array.isArray(data)) {
        throw new Error(`${bank.name} 题库格式不是数组`);
      }
      return data.map((question) => ({
        ...question,
        sourceBankId: bank.id,
        sourceBankName: bank.name,
      }));
    })
  );
  state.allBank = dedupeQuestions(applyVerifiedAnalyses(loadedBanks.flat()));
}

function renderBankSelector() {
  els.bankSelect.innerHTML = "";
  state.banks.forEach((bank) => {
    const option = document.createElement("option");
    option.value = bank.id;
    option.textContent = bank.name;
    els.bankSelect.append(option);
  });
}

function updatePaperModeControls() {
  els.paperModeButtons.forEach((button) => {
    const active = button.dataset.paperMode === state.paperMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setPaperMode(mode) {
  if (!CONFIG.paperModes[mode] || state.paperMode === mode) {
    return;
  }
  state.paperMode = mode;
  updatePaperModeControls();
  drawPaper();
}

function paperCountByType(type) {
  return state.paper.filter((question) => question.type === type).length;
}

function renderPaper() {
  const singleCount = paperCountByType("single");
  const multipleCount = paperCountByType("multiple");
  els.loadingState.hidden = true;
  els.paperRoot.innerHTML = "";
  els.answerBtn.textContent = "";
  els.answerBtn.append(iconEye(), "显示答案");

  const singleSection = createSection("一、单选题", `共 ${singleCount} 题，每题 1 分`);
  const multipleSection = createSection("二、多选题", `共 ${multipleCount} 题，每题 1 分，多选少选均不得分`);
  els.paperRoot.append(singleSection.header, singleSection.root, multipleSection.header, multipleSection.root);

  state.paper.forEach((question, index) => {
    const card = renderQuestion(question, index + 1);
    if (question.type === "single") {
      singleSection.root.append(card);
    } else {
      multipleSection.root.append(card);
    }
  });
}

function createSection(title, meta) {
  const header = document.createElement("div");
  header.className = "section-title";
  header.innerHTML = `<h2>${title}</h2><span>${meta}</span>`;

  const root = document.createElement("div");
  return { header, root };
}

function renderQuestion(question, number) {
  const fragment = els.template.content.cloneNode(true);
  const card = fragment.querySelector(".question-card");
  const type = fragment.querySelector(".question-type");
  const title = fragment.querySelector("h2");
  const result = fragment.querySelector(".question-result");
  const options = fragment.querySelector(".options");
  const answerLine = fragment.querySelector(".answer-line");
  const name = inputName(question);

  card.dataset.questionId = inputName(question);
  type.textContent = `${number}. ${question.type_label}`;
  const wrongBadge = document.createElement("span");
  wrongBadge.className = "wrong-count-pill";
  type.after(wrongBadge);
  updateWrongCountBadge(wrongBadge, question);
  title.textContent = question.question;
  result.textContent = "未判分";
  answerLine.innerHTML = answerMarkup(question);

  optionEntries(question).forEach(([key, text]) => {
    const label = document.createElement("label");
    label.className = "option-row";

    const input = document.createElement("input");
    input.type = question.type === "single" ? "radio" : "checkbox";
    input.name = name;
    input.value = key;
    input.addEventListener("change", () => handleAnswerChange(question));

    const optionText = document.createElement("span");
    optionText.className = "option-text";
    optionText.innerHTML = `<span class="option-key">${key}</span>${escapeHtml(text)}`;

    label.append(input, optionText);
    options.append(label);
  });

  return fragment;
}

function answerMarkup(question) {
  const answer = question.answer.join("");
  const answerText = question.answer_text.join("；");
  return `<strong>正确答案：${answer}</strong><br>${escapeHtml(answerText)}${analysisMarkup(question)}`;
}

function analysisMarkup(question) {
  const analysis = question.analysis;
  if (!analysis) {
    return "";
  }

  if (typeof analysis === "string") {
    return `<div class="analysis-block"><div class="analysis-title">解析</div><p>${escapeHtml(analysis)}</p></div>`;
  }

  if (analysis.verified !== true) {
    return "";
  }

  const summary = analysis.summary ? `<p>${escapeHtml(analysis.summary)}</p>` : "";
  const optionAnalysis = analysis.options || {};
  const optionRows = optionEntries(question)
    .map(([key]) => {
      const text = optionAnalysis[key];
      if (!text) return "";
      const correctClass = question.answer.includes(key) ? " correct" : "";
      return `<li class="analysis-option${correctClass}"><span>${key}</span><p>${escapeHtml(text)}</p></li>`;
    })
    .join("");

  if (!summary && !optionRows) {
    return "";
  }
  const sources = (analysis.sources || [])
    .map((source) => {
      const title = escapeHtml(source.title || source.url || "参考来源");
      const url = escapeHtml(source.url || "");
      if (!url) return "";
      return `<li><a href="${url}" target="_blank" rel="noreferrer">${title}</a></li>`;
    })
    .join("");
  const sourceBlock = sources
    ? `<div class="analysis-sources"><div>参考来源</div><ol>${sources}</ol></div>`
    : "";
  return `<div class="analysis-block"><div class="analysis-title">解析</div>${summary}<ul>${optionRows}</ul>${sourceBlock}</div>`;
}

function analysisSearchText(question) {
  const analysis = question.analysis;
  if (!analysis) {
    return "";
  }
  if (typeof analysis === "string") {
    return analysis;
  }
  if (analysis.verified !== true) {
    return "";
  }
  return [analysis.summary, ...Object.values(analysis.options || {})].filter(Boolean).join(" ");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function updateSummary() {
  const config = getPaperModeConfig();
  const answered = state.paper.filter(isAnswered).length;
  const total = state.paper.length || config.singleCount + config.multipleCount;
  const correct = state.checked ? state.paper.filter(isCorrect).length : null;
  const singleTotal = state.bank.filter((item) => item.type === "single").length;
  const multipleTotal = state.bank.filter((item) => item.type === "multiple").length;
  const paperSingleTotal = state.paper.length ? paperCountByType("single") : config.singleCount;
  const paperMultipleTotal = state.paper.length ? paperCountByType("multiple") : config.multipleCount;

  if (state.mode === "bank") {
    const visibleQuestions = state.bankRenderedQuestions.length ? state.bankRenderedQuestions : state.bank;
    const bankAnswered = visibleQuestions.filter(isBankQuestionAnswered).length;
    const bankCorrect = state.bankChecked ? visibleQuestions.filter(isBankQuestionCorrect).length : null;
    els.scoreLabel.textContent = state.bankChecked ? "题库判分" : "题库总数";
    els.answeredLabel.textContent = state.bankChecked ? "已答" : "总题";
    els.singleCount.textContent = String(singleTotal);
    els.multipleCount.textContent = String(multipleTotal);
    els.answeredCount.textContent = String(state.bankChecked ? bankAnswered : state.bank.length);
    els.correctCount.textContent = bankCorrect === null ? "--" : String(bankCorrect);
    els.scoreValue.textContent = state.bankChecked ? `${bankCorrect} / ${bankAnswered}` : `${state.bank.length} 道`;
    els.progressFill.style.width = "100%";
    if (state.bankChecked) {
      els.statusText.textContent = `题库已判分：当前列表 ${visibleQuestions.length} 题，已答 ${bankAnswered} 题，答对 ${bankCorrect} 题。`;
    } else {
      els.statusText.textContent = state.bankShuffled
        ? "正在乱序查看全部题库，题目和选项均已打乱，可搜索题干、选项或答案。"
        : "正在查看全部题库，可搜索题干、选项或答案。";
    }
    return;
  }

  els.scoreLabel.textContent = `${config.label}得分`;
  els.answeredLabel.textContent = "已答";
  els.singleCount.textContent = String(paperSingleTotal);
  els.multipleCount.textContent = String(paperMultipleTotal);
  els.answeredCount.textContent = String(answered);
  els.correctCount.textContent = correct === null ? "--" : String(correct);
  els.progressFill.style.width = `${total ? Math.round((answered / total) * 100) : 0}%`;

  if (state.checked) {
    els.scoreValue.textContent = `${correct} / ${total}`;
    els.statusText.textContent = `已判分：答对 ${correct} 题，答错 ${total - correct} 题。错题本现有 ${getWrongCount()} 道。`;
  } else {
    els.scoreValue.textContent = `-- / ${total}`;
    const sourceText =
      config.source === "all" ? "从全部题库随机抽取" : config.source === "wrong" ? "从错题本随机抽取" : "从当前题库随机抽取";
    els.statusText.textContent = `${config.label}${sourceText}，已作答 ${answered} / ${total} 题。`;
  }
}

function getViewportAnchor(cardSelector) {
  const activeCard = document.activeElement?.closest?.(cardSelector);
  if (activeCard) {
    return { element: activeCard, top: activeCard.getBoundingClientRect().top };
  }

  const cards = Array.from(document.querySelectorAll(cardSelector));
  const targetTop = Math.min(160, window.innerHeight * 0.24);
  const visibleCards = cards.filter((card) => {
    const rect = card.getBoundingClientRect();
    return rect.bottom > targetTop && rect.top < window.innerHeight;
  });
  const element = visibleCards[0] || cards[0];
  return element ? { element, top: element.getBoundingClientRect().top } : null;
}

function restoreViewportAnchor(anchor) {
  if (!anchor?.element?.isConnected) {
    return;
  }
  requestAnimationFrame(() => {
    if (!anchor.element.isConnected) {
      return;
    }
    const nextTop = anchor.element.getBoundingClientRect().top;
    window.scrollBy({ top: nextTop - anchor.top, left: 0, behavior: "auto" });
  });
}

function checkPaper() {
  const anchor = getViewportAnchor(".question-card");
  state.checked = true;
  state.answersVisible = true;
  state.paper.forEach((question) => {
    updateQuestionResult(question);
  });
  updateWrongRecordsFromPaper();
  state.paper.forEach(updateQuestionWrongCount);
  els.answerBtn.textContent = "";
  els.answerBtn.append(iconEye(), "隐藏答案");
  updateSummary();
  restoreViewportAnchor(anchor);
}

function handleAnswerChange(question) {
  if (state.checked) {
    updateQuestionResult(question);
    if (isCorrect(question)) {
      removeWrongRecord(question);
      state.paperWrongRecordedKeys.delete(wrongRecordKey(question));
    } else {
      updateWrongRecordForQuestion(question);
    }
    saveWrongRecords();
    updateQuestionWrongCount(question);
  }
  updateSummary();
}

function updateQuestionResult(question) {
  const card = document.querySelector(`[data-question-id="${inputName(question)}"]`);
  if (!card) return;

  const result = card.querySelector(".question-result");
  const answerLine = card.querySelector(".answer-line");
  const correct = isCorrect(question);

  card.classList.toggle("correct", correct);
  card.classList.toggle("wrong", !correct);
  result.textContent = correct ? "正确" : "错误";
  answerLine.classList.toggle("visible", state.answersVisible);
}

function updateQuestionWrongCount(question) {
  const card = document.querySelector(`[data-question-id="${inputName(question)}"]`);
  const badge = card?.querySelector(".wrong-count-pill");
  if (badge) {
    updateWrongCountBadge(badge, question);
  }
}

function updateWrongCountBadge(badge, question) {
  const text = wrongCountText(question);
  badge.textContent = text;
  badge.hidden = !text;
}

function toggleAnswers() {
  const anchor = getViewportAnchor(".question-card");
  state.answersVisible = !state.answersVisible;
  document.querySelectorAll(".answer-line").forEach((line) => {
    line.classList.toggle("visible", state.answersVisible);
  });
  els.answerBtn.textContent = "";
  els.answerBtn.append(iconEye(), state.answersVisible ? "隐藏答案" : "显示答案");
  restoreViewportAnchor(anchor);
}

function setMode(mode) {
  state.mode = mode;
  const inBankMode = mode === "bank";
  els.paperRoot.hidden = inBankMode;
  els.bankRoot.hidden = !inBankMode;
  els.newPaperBtn.hidden = inBankMode;
  els.checkBtn.hidden = inBankMode;
  els.answerBtn.hidden = inBankMode;
  els.bankViewBtn.textContent = "";
  els.bankViewBtn.append(iconList(), inBankMode ? "返回练习" : "全部题库");

  if (inBankMode) {
    state.bankChecked = false;
    renderBank();
  }
  updateSummary();
}

function toggleBankMode() {
  setMode(state.mode === "bank" ? "practice" : "bank");
}

function startWrongReview() {
  if (getWrongCount() === 0) {
    els.statusText.textContent = "暂无错题。交卷判分后，答错或未答的题会自动加入错题本。";
    updateWrongControls();
    return;
  }
  state.paperMode = "wrong";
  updatePaperModeControls();
  drawPaper();
  window.scrollTo({ top: 0, behavior: "auto" });
}

function clearWrongRecords() {
  if (getWrongCount() === 0) {
    return;
  }
  if (!window.confirm("确定清空全部错题记录吗？")) {
    return;
  }
  state.wrongRecords = {};
  saveWrongRecords();
  if (state.paperMode === "wrong") {
    state.paperMode = "practice";
    updatePaperModeControls();
    drawPaper();
    return;
  }
  updateSummary();
}

function resetBankShuffle() {
  state.bankShuffled = false;
  state.bankShuffleOrder = [];
  state.bankOptionVariants = new Map();
  state.bankWrongRecordedKeys = new Set();
  updateBankShuffleControls();
}

function ensureBankShuffleOrder() {
  if (state.bankShuffleOrder.length !== state.bank.length) {
    state.bankShuffleOrder = shuffle(state.bank.map((_, index) => index));
  }
}

function getBankDisplayQuestions() {
  if (!state.bankShuffled) {
    return state.bank;
  }
  ensureBankShuffleOrder();
  return state.bankShuffleOrder.map((index) => state.bank[index]).filter(Boolean);
}

function getBankRenderQuestion(question) {
  if (!state.bankShuffled) {
    return question;
  }
  const key = bankInputName(question);
  const cached = state.bankOptionVariants.get(key);
  if (cached) {
    return cached;
  }
  const randomized = randomizeQuestionOptions({ ...question });
  state.bankOptionVariants.set(key, randomized);
  return randomized;
}

function updateBankShuffleControls() {
  if (!els.bankShuffleToggle) {
    return;
  }
  els.bankShuffleToggle.classList.toggle("active", state.bankShuffled);
  els.bankShuffleToggle.setAttribute("aria-pressed", String(state.bankShuffled));
  els.bankShuffleToggle.textContent = "";
  els.bankShuffleToggle.append(iconShuffle(), state.bankShuffled ? "恢复顺序" : "乱序显示");
}

function toggleBankShuffle() {
  state.bankShuffled = !state.bankShuffled;
  state.bankChecked = false;
  state.bankWrongRecordedKeys = new Set();
  if (state.bankShuffled) {
    state.bankShuffleOrder = shuffle(state.bank.map((_, index) => index));
    state.bankOptionVariants = new Map();
  } else {
    state.bankShuffleOrder = [];
    state.bankOptionVariants = new Map();
  }
  updateBankShuffleControls();
  renderBank();
  updateSummary();
}

function renderBank() {
  const keyword = els.bankSearch.value.trim().toLowerCase();
  const type = els.bankTypeFilter.value;
  const filtered = getBankDisplayQuestions().filter((question) => {
    if (type !== "all" && question.type !== type) {
      return false;
    }
    if (!keyword) {
      return true;
    }
    const haystack = [
      question.question,
      question.type_label,
      ...Object.values(question.options),
      ...(question.answer_text || []),
      ...(question.answer || []),
      analysisSearchText(question),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(keyword);
  });

  const renderedQuestions = filtered.map(getBankRenderQuestion);
  state.bankRenderedQuestions = renderedQuestions;
  els.bankList.innerHTML = "";
  if (renderedQuestions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-bank";
    empty.textContent = "没有匹配的题目。";
    els.bankList.append(empty);
    return;
  }

  renderedQuestions.forEach((question, index) => {
    els.bankList.append(renderBankQuestion(question, index + 1));
  });
}

function renderBankQuestion(question, number) {
  const card = document.createElement("article");
  card.className = "bank-card";
  card.dataset.bankQuestionId = bankInputName(question);

  const meta = document.createElement("div");
  meta.className = "bank-meta-line";
  const type = document.createElement("span");
  type.textContent = `${number}. ${question.type_label}`;
  const result = document.createElement("span");
  result.className = "bank-result";
  result.textContent = state.bankChecked
    ? isBankQuestionAnswered(question)
      ? isBankQuestionCorrect(question)
        ? "正确"
        : "错误"
      : "未答"
    : "未判分";
  const wrongCount = document.createElement("span");
  wrongCount.className = "bank-wrong-count";
  wrongCount.textContent = wrongCountText(question);
  wrongCount.hidden = !wrongCount.textContent;
  const id = document.createElement("span");
  id.textContent = `ID ${question.id}`;
  meta.append(type, wrongCount, result, id);

  const title = document.createElement("h2");
  title.textContent = question.question;

  const options = document.createElement("div");
  options.className = "bank-options";
  optionEntries(question).forEach(([key, text]) => {
    const label = document.createElement("label");
    label.className = "bank-option bank-option-row";

    const input = document.createElement("input");
    input.type = question.type === "single" ? "radio" : "checkbox";
    input.name = bankInputName(question);
    input.value = key;
    input.addEventListener("change", () => handleBankAnswerChange(question));

    const optionText = document.createElement("span");
    optionText.className = "option-text";
    optionText.innerHTML = `<span class="option-key">${key}</span>${escapeHtml(text)}`;

    label.append(input, optionText);
    options.append(label);
  });

  const answer = document.createElement("div");
  answer.className = `bank-answer${state.bankAnswersVisible ? " visible" : ""}`;
  answer.innerHTML = answerMarkup(question);

  if (state.bankChecked) {
    const answered = isBankQuestionAnswered(question);
    const correct = isBankQuestionCorrect(question);
    card.classList.toggle("correct", answered && correct);
    card.classList.toggle("wrong", answered && !correct);
  }

  card.append(meta, title, options, answer);
  return card;
}

function updateBankAnswerControls() {
  els.bankAnswerToggle.textContent = state.bankAnswersVisible ? "隐藏答案" : "显示答案";
}

function updateBankQuestionResult(question) {
  const card = document.querySelector(`[data-bank-question-id="${bankInputName(question)}"]`);
  if (!card) return;

  const result = card.querySelector(".bank-result");
  const answer = card.querySelector(".bank-answer");
  const answered = isBankQuestionAnswered(question);
  const correct = isBankQuestionCorrect(question);

  if (!answered) {
    card.classList.remove("correct", "wrong");
    result.textContent = "未答";
    answer.classList.toggle("visible", state.bankAnswersVisible);
    return;
  }

  card.classList.toggle("correct", correct);
  card.classList.toggle("wrong", !correct);
  result.textContent = correct ? "正确" : "错误";
  answer.classList.toggle("visible", state.bankAnswersVisible);
}

function handleBankAnswerChange(question) {
  if (state.bankChecked) {
    updateWrongRecordForBankQuestion(question);
    saveWrongRecords();
    updateBankQuestionResult(question);
    updateBankQuestionWrongCount(question);
  }
  updateSummary();
}

function updateBankQuestionWrongCount(question) {
  const card = document.querySelector(`[data-bank-question-id="${bankInputName(question)}"]`);
  const badge = card?.querySelector(".bank-wrong-count");
  if (badge) {
    updateWrongCountBadge(badge, question);
  }
}

function checkBankAnswers() {
  const anchor = getViewportAnchor(".bank-card");
  state.bankChecked = true;
  state.bankAnswersVisible = true;
  updateWrongRecordsFromBank();
  state.bankRenderedQuestions.forEach(updateBankQuestionResult);
  state.bankRenderedQuestions.forEach(updateBankQuestionWrongCount);
  updateBankAnswerControls();
  updateSummary();
  restoreViewportAnchor(anchor);
}

function resetBankAnswers() {
  const anchor = getViewportAnchor(".bank-card");
  state.bankChecked = false;
  state.bankAnswersVisible = false;
  state.bankWrongRecordedKeys = new Set();
  updateBankAnswerControls();
  renderBank();
  updateSummary();
  restoreViewportAnchor(anchor);
}

function handleBankListChange() {
  state.bankChecked = false;
  state.bankWrongRecordedKeys = new Set();
  renderBank();
  updateSummary();
}

function toggleBankAnswers() {
  const anchor = getViewportAnchor(".bank-card");
  state.bankAnswersVisible = !state.bankAnswersVisible;
  updateBankAnswerControls();
  document.querySelectorAll(".bank-answer").forEach((line) => {
    line.classList.toggle("visible", state.bankAnswersVisible);
  });
  restoreViewportAnchor(anchor);
}

function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select";
}

function handleKeyboardShortcut(event) {
  if (event.key.toLowerCase() !== "p" || event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) {
    return;
  }
  event.preventDefault();
  if (state.mode === "bank") {
    toggleBankAnswers();
    return;
  }
  toggleAnswers();
}

function iconEye() {
  const wrapper = document.createElement("span");
  wrapper.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  return wrapper.firstChild;
}

function iconShuffle() {
  const wrapper = document.createElement("span");
  wrapper.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>';
  return wrapper.firstChild;
}

function iconList() {
  const wrapper = document.createElement("span");
  wrapper.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>';
  return wrapper.firstChild;
}

function bindEvents() {
  els.bankSelect.addEventListener("change", switchBank);
  els.paperModeButtons.forEach((button) => {
    button.addEventListener("click", () => setPaperMode(button.dataset.paperMode));
  });
  els.bankViewBtn.addEventListener("click", toggleBankMode);
  els.bankSearch.addEventListener("input", handleBankListChange);
  els.bankTypeFilter.addEventListener("change", handleBankListChange);
  els.bankAnswerToggle.addEventListener("click", toggleBankAnswers);
  els.bankShuffleToggle.addEventListener("click", toggleBankShuffle);
  els.bankCheckBtn.addEventListener("click", checkBankAnswers);
  els.bankResetBtn.addEventListener("click", resetBankAnswers);
  els.wrongReviewBtn.addEventListener("click", startWrongReview);
  els.clearWrongBtn.addEventListener("click", clearWrongRecords);
  els.newPaperBtn.addEventListener("click", drawPaper);
  els.checkBtn.addEventListener("click", checkPaper);
  els.answerBtn.addEventListener("click", toggleAnswers);
  document.addEventListener("keydown", handleKeyboardShortcut);
}

async function loadBank() {
  const selectedId = els.bankSelect.value || state.banks[0]?.id;
  const selectedBank = state.banks.find((bank) => bank.id === selectedId) || state.banks[0];
  if (!selectedBank) {
    throw new Error("没有可用题库");
  }

  const data = await fetchFirstJson(buildPathCandidates(selectedBank.path));
  if (!Array.isArray(data)) {
    throw new Error("题库格式不是数组");
  }

  state.activeBank = selectedBank;
  state.bank = applyVerifiedAnalyses(
    data.map((question) => ({
      ...question,
      sourceBankId: selectedBank.id,
      sourceBankName: selectedBank.name,
    }))
  );
  els.bankSelect.value = selectedBank.id;

  const singleTotal = state.bank.filter((item) => item.type === "single").length;
  const multipleTotal = state.bank.filter((item) => item.type === "multiple").length;
  els.bankMeta.textContent = `${selectedBank.name} ${state.bank.length} 道：单选 ${singleTotal} 道，多选 ${multipleTotal} 道`;
}

async function switchBank() {
  els.loadingState.hidden = false;
  els.loadingState.textContent = "正在读取题库...";
  els.paperRoot.innerHTML = "";
  els.bankList.innerHTML = "";
  state.checked = false;
  state.bankChecked = false;
  state.answersVisible = false;
  state.bankAnswersVisible = false;
  state.bankWrongRecordedKeys = new Set();
  updateBankAnswerControls();
  els.bankSearch.value = "";
  els.bankTypeFilter.value = "all";
  resetBankShuffle();
  state.paperMode = "practice";
  updatePaperModeControls();
  try {
    await loadBank();
    drawPaper();
  } catch (error) {
    els.loadingState.hidden = false;
    els.loadingState.textContent = `${error.message}。请检查题库列表和 JSON 文件路径。`;
    els.statusText.textContent = "题库加载失败。";
    console.error(error);
  }
}

async function init() {
  loadWrongRecords();
  bindEvents();
  updatePaperModeControls();
  updateWrongControls();
  updateBankShuffleControls();
  try {
    await loadBankManifest();
    await loadVerifiedAnalyses();
    await loadAllBanks();
    await loadBank();
    drawPaper();
  } catch (error) {
    els.loadingState.hidden = false;
    els.loadingState.textContent = `${error.message}。请通过本目录的本地服务器打开页面。`;
    els.statusText.textContent = "题库加载失败。";
    console.error(error);
  }
}

init();
