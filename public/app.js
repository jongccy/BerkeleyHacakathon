const $ = (id) => document.getElementById(id);

const DISPLAY = {
  vehicle_access: {
    yes: "Yes, I have a vehicle",
    no: "No, I need transit or pickup",
  },
  vehicle_count: {
    "1": "1 vehicle",
    "2": "2 vehicles",
    "3plus": "3 or more vehicles",
    na: "Not applicable — no vehicle",
  },
  evacuating: {
    solo: "No dependents",
    small: "1 to 2 dependents",
    large: "3 or more dependents",
  },
  vulnerable: {
    none: "None",
    infants: "Yes, infants under 2",
    seniors: "Yes, seniors 75+",
    both: "Yes, both",
  },
  accessibility: {
    none: "None needed",
    wheelchair: "Wheelchair accessible facility required",
    medical: "Medical equipment power required",
    other: "Other",
  },
  animals: {
    none: "No pets",
    pets: "Yes, bringing domestic pets",
    service: "Certified service animal only",
  },
};

const REVIEW_KEYS = [
  { key: "address", label: "Current address" },
  { key: "vehicle_access", label: "Vehicle access" },
  { key: "vehicle_count", label: "Vehicles available" },
  { key: "evacuating", label: "Dependents to pick up" },
  { key: "vulnerable", label: "Infants or seniors 75+" },
  { key: "accessibility", label: "Accessibility needs" },
  { key: "animals", label: "Animals" },
];

const state = {
  step: 0,
  selectedAddress: null,
  data: {},
};

let isTransitioning = false;

const TRANSITION_FALLBACK_MS = 320;

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function waitStepTransition(el) {
  if (!el || prefersReducedMotion()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("transitionend", onEnd);
      clearTimeout(fallback);
      resolve();
    };
    const onEnd = (e) => {
      if (e.target === el && (e.propertyName === "opacity" || e.propertyName === "transform")) {
        finish();
      }
    };
    el.addEventListener("transitionend", onEnd);
    const fallback = setTimeout(finish, TRANSITION_FALLBACK_MS);
  });
}

function triggerEnterAnimation(el) {
  if (!el || prefersReducedMotion()) return Promise.resolve();
  el.classList.add("is-entering");
  void el.offsetHeight;
  el.classList.remove("is-entering");
  return waitStepTransition(el);
}

function revealReviewList() {
  const list = $("review-list");
  if (!list) return;
  list.classList.remove("is-visible");
  if (prefersReducedMotion()) {
    list.classList.add("is-visible");
    return;
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => list.classList.add("is-visible"));
  });
}

function revealResultCard() {
  const card = $("result-card");
  if (!card) return;
  card.classList.remove("is-visible");
  if (prefersReducedMotion()) {
    card.classList.add("is-visible");
    return;
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => card.classList.add("is-visible"));
  });
}

const ADDRESS_FIELD_HTML = `
  <input id="address" type="text" placeholder="e.g. 123 Main St, Lahaina, HI" autocomplete="off" aria-autocomplete="list" aria-controls="addr-suggestions" aria-expanded="false">
  <ul id="addr-suggestions" class="addr-suggestions" hidden role="listbox" aria-label="Address suggestions"></ul>
`;

function selectedRadio(name) {
  const el = document.querySelector(`input[name="${name}"]:checked`);
  return el ? el.value : null;
}

function hasVehicle() {
  return state.data.vehicle_access === "yes";
}

function getNextStep(from) {
  if (from === 3 && !hasVehicle()) return 5;
  return from + 1;
}

function getPrevStep(from) {
  if (from === 5 && !hasVehicle()) return 3;
  if (from === 10) return 8;
  return from - 1;
}

function updateProgressLabel() {
  const el = $("progress-label");
  if (!el) return;
  if (state.step === 0) {
    el.textContent = "";
    return;
  }
  if (state.step >= 2 && state.step <= 8) {
    el.textContent = `Question ${state.step - 1} of 7`;
  } else if (state.step === 10) {
    el.textContent = "Review";
  } else if (state.step === 11) {
    el.textContent = "";
  } else {
    el.textContent = "Profile setup";
  }
}

async function goToStep(next) {
  if (isTransitioning) return;

  const current = document.querySelector(`.step[data-step="${state.step}"]`);
  const target = document.querySelector(`.step[data-step="${next}"]`);
  if (!target) return;
  if (current === target) return;

  isTransitioning = true;

  try {
    if (current && current !== target) {
      current.classList.add("is-leaving", "is-animating");
      current.classList.remove("is-active", "is-entering");
      await waitStepTransition(current);
      current.classList.remove("is-leaving", "is-animating");
    }

    state.step = next;
    updateProgressLabel();

    target.classList.add("is-active", "is-animating");
    await triggerEnterAnimation(target);
    target.classList.remove("is-animating");

    if (next === 2) initAddress();
    if (next === 10) {
      renderReview();
      revealReviewList();
    }
    if (next === 11) revealResultCard();
  } finally {
    isTransitioning = false;
  }
}

function goNext() {
  if (isTransitioning) return;
  if (!validateStep(state.step)) return;
  if (state.step === 8) {
    goToStep(10);
    return;
  }
  goToStep(getNextStep(state.step));
}

function goBack() {
  if (state.step === 0 || isTransitioning) return;
  goToStep(getPrevStep(state.step));
}

function validateStep(step) {
  if (step === 1) {
    const name = $("name").value.trim();
    const phone = $("phone").value.trim();
    if (!name) {
      $("name").focus();
      return false;
    }
    if (!isPhoneComplete(phone)) {
      $("phone").focus();
      setPhoneHint("Enter a complete 10-digit US mobile number.", true);
      return false;
    }
    const { month, day, year } = getDobValues();
    if (!month || !day || !year) {
      setDobHint("Select your birth year, month, and day.", true);
      if (!year) activateDobTab("year");
      else if (!month) activateDobTab("month");
      else activateDobTab("day");
      return false;
    }
    if (!isValidDob(month, day, year)) {
      setDobHint("Enter a valid date of birth.", true);
      return false;
    }
    setPhoneHint("");
    setDobHint("");
    state.data.name = name;
    state.data.phone = formatPhoneDisplay(phone);
    state.data.birth_date = formatBirthDate(month, day, year);
    state.data.age = computeAge(month, day, year);
    return true;
  }

  if (step === 2) {
    if (!state.selectedAddress?.address) {
      const addr = ($("address") || {}).value?.trim() || "";
      if (!addr) {
        setHint("Enter your exact current address.", true);
        return false;
      }
      setHint("Choose an address from the suggestions.", true);
      return false;
    }
    state.data.address = state.selectedAddress.address;
    return true;
  }

  const radioSteps = {
    3: "vehicle_access",
    4: "vehicle_count",
    5: "evacuating",
    6: "vulnerable",
    8: "animals",
  };

  if (step === 7) {
    const val = selectedRadio("accessibility");
    if (!val) return false;
    if (val === "other") {
      const text = ($("accessibility-other") || {}).value?.trim() || "";
      if (!text) {
        $("accessibility-other")?.focus();
        return false;
      }
      state.data.accessibility = val;
      state.data.accessibility_other = text;
      return true;
    }
    state.data.accessibility = val;
    delete state.data.accessibility_other;
    return true;
  }

  if (radioSteps[step]) {
    const name = radioSteps[step];
    const val = selectedRadio(name);
    if (!val) return false;
    state.data[name] = val;
    if (name === "vehicle_access" && val === "no") {
      state.data.vehicle_count = "na";
    }
    return true;
  }

  return true;
}

function setPhoneHint(msg, isError = false) {
  const el = $("phone-hint");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("is-error", isError);
}

function setHint(msg, isError = false) {
  const el = $("addr-hint");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("is-error", isError);
}

/** Strip to US digits: 10 national digits, optional leading 1. */
function phoneDigits(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("1")) d = d.slice(1);
  return d.slice(0, 10);
}

/** Display: +1 (555) 555-5555 */
function formatPhoneDisplay(raw) {
  const d = phoneDigits(raw);
  if (!d.length) return "+1 ";
  if (d.length <= 3) return `+1 (${d}`;
  if (d.length <= 6) return `+1 (${d.slice(0, 3)}) ${d.slice(3)}`;
  return `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function isPhoneComplete(raw) {
  return phoneDigits(raw).length === 10;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function daysInMonth(month, year) {
  if (!month || !year) return 31;
  return new Date(Number(year), Number(month), 0).getDate();
}

function initDobPicker() {
  const monthEl = $("dob-month");
  const yearEl = $("dob-year");
  if (!monthEl || !yearEl) return;

  MONTH_NAMES.forEach((name, i) => {
    const opt = document.createElement("option");
    opt.value = String(i + 1);
    opt.textContent = name;
    monthEl.appendChild(opt);
  });

  const currentYear = new Date().getFullYear();
  for (let y = currentYear; y >= currentYear - 100; y--) {
    const opt = document.createElement("option");
    opt.value = String(y);
    opt.textContent = String(y);
    yearEl.appendChild(opt);
  }

  updateDayOptions();
}

function updateDayOptions() {
  const monthEl = $("dob-month");
  const dayEl = $("dob-day");
  const yearEl = $("dob-year");
  if (!monthEl || !dayEl || !yearEl) return;

  const month = monthEl.value;
  const year = yearEl.value;
  const prevDay = dayEl.value;
  const maxDays = daysInMonth(month, year);

  dayEl.innerHTML = '<option value="">Select day</option>';
  for (let d = 1; d <= maxDays; d++) {
    const opt = document.createElement("option");
    opt.value = String(d);
    opt.textContent = String(d);
    dayEl.appendChild(opt);
  }

  if (prevDay && Number(prevDay) <= maxDays) {
    dayEl.value = prevDay;
  }

  updateDobTabLabels();
}

function updateDobTabLabels() {
  const monthEl = $("dob-month");
  const dayEl = $("dob-day");
  const yearEl = $("dob-year");
  const tabMonth = $("dob-tab-month");
  const tabDay = $("dob-tab-day");
  const tabYear = $("dob-tab-year");
  if (!monthEl || !dayEl || !yearEl || !tabMonth || !tabDay || !tabYear) return;

  if (monthEl.value) {
    tabMonth.textContent = MONTH_NAMES[Number(monthEl.value) - 1].slice(0, 3);
    tabMonth.classList.add("has-value");
  } else {
    tabMonth.textContent = "Month";
    tabMonth.classList.remove("has-value");
  }

  if (dayEl.value) {
    tabDay.textContent = dayEl.value;
    tabDay.classList.add("has-value");
  } else {
    tabDay.textContent = "Day";
    tabDay.classList.remove("has-value");
  }

  if (yearEl.value) {
    tabYear.textContent = yearEl.value;
    tabYear.classList.add("has-value");
  } else {
    tabYear.textContent = "Year";
    tabYear.classList.remove("has-value");
  }
}

function activateDobTab(tabName) {
  document.querySelectorAll(".dob-tab").forEach((tab) => {
    const active = tab.dataset.dobTab === tabName;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });

  document.querySelectorAll(".dob-panel").forEach((panel) => {
    const active = panel.id === `dob-panel-${tabName}`;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  });

  const select = $(`dob-${tabName}`);
  select?.focus();
}

function getDobValues() {
  return {
    month: ($("dob-month") || {}).value || "",
    day: ($("dob-day") || {}).value || "",
    year: ($("dob-year") || {}).value || "",
  };
}

function isValidDob(month, day, year) {
  if (!month || !day || !year) return false;
  const m = Number(month);
  const d = Number(day);
  const y = Number(year);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    return false;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date <= today;
}

function computeAge(month, day, year) {
  const today = new Date();
  let age = today.getFullYear() - Number(year);
  const monthDiff = today.getMonth() + 1 - Number(month);
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < Number(day))) {
    age -= 1;
  }
  return age;
}

function formatBirthDate(month, day, year) {
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${year}-${m}-${d}`;
}

function setDobHint(msg, isError = false) {
  const el = $("dob-hint");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("is-error", isError);
}

function bindDobPicker() {
  initDobPicker();

  document.querySelectorAll(".dob-tab").forEach((tab) => {
    tab.addEventListener("click", () => activateDobTab(tab.dataset.dobTab));
  });

  $("dob-year")?.addEventListener("change", () => {
    updateDayOptions();
    if ($("dob-year").value) activateDobTab("month");
  });

  $("dob-month")?.addEventListener("change", () => {
    updateDayOptions();
    if ($("dob-month").value) activateDobTab("day");
  });

  $("dob-day")?.addEventListener("change", () => {
    updateDobTabLabels();
  });
}

function resetDobPicker() {
  const monthEl = $("dob-month");
  const dayEl = $("dob-day");
  const yearEl = $("dob-year");
  if (monthEl) monthEl.value = "";
  if (dayEl) dayEl.value = "";
  if (yearEl) yearEl.value = "";
  updateDayOptions();
  activateDobTab("year");
  setDobHint("");
}

function bindPhoneInput() {
  const input = $("phone");
  if (!input) return;

  const applyFormat = () => {
    const formatted = formatPhoneDisplay(input.value);
    input.value = formatted;
  };

  input.addEventListener("focus", () => {
    if (!input.value.trim()) input.value = "+1 ";
  });

  input.addEventListener("blur", () => {
    if (phoneDigits(input.value).length === 0) input.value = "";
  });

  input.addEventListener("input", applyFormat);

  input.addEventListener("keydown", (e) => {
    const start = input.selectionStart ?? 0;
    if (e.key === "Backspace" && start <= 3) {
      e.preventDefault();
    }
    if (e.key === "Delete" && start < 3) {
      e.preventDefault();
    }
  });

  input.addEventListener("paste", (e) => {
    e.preventDefault();
    const pasted = (e.clipboardData || window.clipboardData).getData("text");
    input.value = formatPhoneDisplay(phoneDigits(pasted));
  });
}

function bindAddressAutocomplete() {
  const input = $("address");
  const list = $("addr-suggestions");
  const wrap = $("addr-slot");
  if (!input || !list || !wrap) return;

  let suggestTimer = null;
  let activeIndex = -1;
  let suggestions = [];
  let fetchAbort = null;

  const setListOpen = (open) => {
    input.classList.toggle("has-suggestions", open);
    input.setAttribute("aria-expanded", open ? "true" : "false");
  };

  const hideList = () => {
    list.hidden = true;
    list.innerHTML = "";
    activeIndex = -1;
    suggestions = [];
    setListOpen(false);
  };

  const highlightActive = () => {
    list.querySelectorAll(".addr-suggestions__item").forEach((el, i) => {
      el.classList.toggle("is-active", i === activeIndex);
      if (i === activeIndex) el.scrollIntoView({ block: "nearest" });
    });
  };

  const selectSuggestion = (item) => {
    state.selectedAddress = { address: item.label, lat: item.lat, lng: item.lng };
    state.data.address = item.label;
    input.value = item.label;
    hideList();
    setHint("Selected: " + item.label);
  };

  const renderList = (items) => {
    suggestions = items;
    activeIndex = -1;
    if (!items.length) {
      list.innerHTML = '<li class="addr-suggestions__empty">No matches — keep typing</li>';
      list.hidden = false;
      setListOpen(true);
      return;
    }
    list.innerHTML = items
      .map(
        (item, i) =>
          `<li class="addr-suggestions__item" role="option" data-index="${i}">${escapeHtml(item.label)}</li>`
      )
      .join("");
    list.hidden = false;
    setListOpen(true);
  };

  const fetchSuggestions = async (q) => {
    if (fetchAbort) fetchAbort.abort();
    fetchAbort = new AbortController();
    try {
      const res = await fetch(`/api/address/suggest?q=${encodeURIComponent(q)}`, {
        signal: fetchAbort.signal,
      });
      if (!res.ok) return;
      const data = await res.json();
      if (input.value.trim() !== q) return;
      renderList(Array.isArray(data) ? data : []);
    } catch (err) {
      if (err.name !== "AbortError") hideList();
    }
  };

  input.addEventListener("input", () => {
    const q = input.value.trim();
    if (state.selectedAddress && state.selectedAddress.address !== input.value) {
      state.selectedAddress = null;
    }
    if (q.length < 2) {
      hideList();
      setHint("Start typing your US address.");
      return;
    }
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => fetchSuggestions(q), 250);
    setHint("Pick your address from the list.");
  });

  input.addEventListener("keydown", (e) => {
    if (list.hidden || !suggestions.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, suggestions.length - 1);
      highlightActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      highlightActive();
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      selectSuggestion(suggestions[activeIndex]);
    } else if (e.key === "Escape") {
      hideList();
    }
  });

  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest(".addr-suggestions__item");
    if (!li) return;
    e.preventDefault();
    const idx = Number(li.dataset.index);
    if (Number.isFinite(idx) && suggestions[idx]) selectSuggestion(suggestions[idx]);
  });

  input.addEventListener("blur", () => {
    setTimeout(hideList, 150);
  });

  input.addEventListener("focus", () => {
    const q = input.value.trim();
    if (q.length >= 2 && !state.selectedAddress) fetchSuggestions(q);
  });
}

function initAddress() {
  const slot = $("addr-slot");
  if (!slot || slot.dataset.initialized === "1") return;
  slot.dataset.initialized = "1";
  setHint("Start typing your US address.");
  bindAddressAutocomplete();
}

function displayValue(key) {
  const val = state.data[key];
  if (key === "address") return state.data.address || "—";
  if (key === "accessibility" && val === "other") return state.data.accessibility_other || "Other";
  const map = DISPLAY[key];
  return map?.[val] || val || "—";
}

function renderReview() {
  const list = $("review-list");
  list.classList.remove("is-visible");
  list.innerHTML = REVIEW_KEYS.map(({ key, label }, i) => {
    const value = displayValue(key);
    return `<li class="review-item" style="--i: ${i}">
      <label class="review-item__label">
        <input type="checkbox" class="review-item__check" data-review-key="${key}">
        <span class="review-item__content">
          <span class="review-item__title">${escapeHtml(label)}</span>
          <span class="review-item__value">${escapeHtml(value)}</span>
        </span>
      </label>
    </li>`;
  }).join("");

  $("btn-activate").disabled = true;
  list.querySelectorAll(".review-item__check").forEach((cb) => {
    cb.addEventListener("change", updateActivateButton);
  });
}

function updateActivateButton() {
  const checks = document.querySelectorAll(".review-item__check");
  const allChecked = [...checks].every((c) => c.checked);
  $("btn-activate").disabled = !allChecked;
}

function buildApiProfile() {
  const d = state.data;
  const householdMap = { solo: 1, small: 3, large: 5 };
  const dependentsNote = {
    solo: "No dependents at separate locations",
    small: "1–2 dependents who may need pickup elsewhere",
    large: "3+ dependents who may need pickup elsewhere",
  };
  const mobilityParts = [];
  if (d.accessibility === "wheelchair") mobilityParts.push("wheelchair accessible facility required");
  else if (d.accessibility === "medical") mobilityParts.push("medical equipment power required");
  else if (d.accessibility === "other" && d.accessibility_other) mobilityParts.push(d.accessibility_other);
  if (d.vulnerable === "infants") mobilityParts.push("infants under 2 in group");
  else if (d.vulnerable === "seniors") mobilityParts.push("seniors 75+ in group");
  else if (d.vulnerable === "both") mobilityParts.push("infants under 2 and seniors 75+ in group");

  return {
    name: d.name,
    phone: d.phone,
    birth_date: d.birth_date,
    age: d.age,
    address: d.address,
    vehicle_access: DISPLAY.vehicle_access[d.vehicle_access],
    vehicle_count: DISPLAY.vehicle_count[d.vehicle_count],
    evacuating_group: dependentsNote[d.evacuating] || DISPLAY.evacuating[d.evacuating],
    vulnerable_members: DISPLAY.vulnerable[d.vulnerable],
    accessibility_needs:
      d.accessibility === "other"
        ? d.accessibility_other || "Other"
        : DISPLAY.accessibility[d.accessibility],
    animals: DISPLAY.animals[d.animals],
    language: "en",
    household_size: householdMap[d.evacuating] || 1,
    has_car: d.vehicle_access === "yes" ? 1 : 0,
    mobility_needs: mobilityParts.length ? mobilityParts.join("; ") : "none",
    pets: d.animals === "none" ? 0 : 1,
  };
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderResult(data) {
  const card = $("result-card");
  const failSafe = data.fail_safe === true;
  card.classList.toggle("is-failsafe", failSafe);
  card.classList.remove("is-visible");

  const badge = failSafe ? "Advisory mode" : data.applies_to_user === false ? "Not in affected area" : "Your guidance";
  const action = data.recommended_action || "No active guidance at this time.";
  const summary = data.authoritative_summary || "";
  const zone = data.zone ?? "—";
  const resolved = data.resolved?.address || state.data.address || "—";

  card.innerHTML = `
    <span class="result-card__badge">${escapeHtml(badge)}</span>
    <p class="result-card__action">${escapeHtml(action)}</p>
    ${summary ? `<p class="result-card__summary">${escapeHtml(summary)}</p>` : ""}
    <dl class="result-card__meta">
      <dt>Home</dt><dd>${escapeHtml(resolved)}</dd>
      <dt>Zone</dt><dd>${escapeHtml(zone || "Unknown")}</dd>
      ${data.destination ? `<dt>Shelter</dt><dd>${escapeHtml(data.destination)}</dd>` : ""}
    </dl>
  `;
}

async function fetchGuidance() {
  const btn = $("btn-activate");
  btn.classList.add("btn--loading");
  btn.disabled = true;
  btn.textContent = "Activating";

  const body = buildApiProfile();

  if (state.selectedAddress) {
    body.address = state.selectedAddress.address;
    if (typeof state.selectedAddress.lat === "number") {
      body.lat = state.selectedAddress.lat;
      body.lng = state.selectedAddress.lng;
    }
  }

  try {
    const res = await fetch("/api/advise", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Something went wrong. Please try again.");
      btn.classList.remove("btn--loading");
      btn.disabled = false;
      btn.textContent = "Activate Profile";
      updateActivateButton();
      return;
    }
    renderResult(data);
    goToStep(11);
  } catch {
    alert("Request failed. Check your connection.");
    btn.classList.remove("btn--loading");
    btn.disabled = false;
    btn.textContent = "Activate Profile";
    updateActivateButton();
  }
}

function resetForm() {
  isTransitioning = false;
  state.selectedAddress = null;
  state.data = {};
  state.step = 0;

  $("name").value = "";
  $("phone").value = "";
  document.querySelectorAll('input[type="radio"]').forEach((r) => (r.checked = false));

  const otherField = $("accessibility-other-field");
  const otherInput = $("accessibility-other");
  if (otherInput) otherInput.value = "";
  if (otherField) otherField.classList.remove("is-open");

  const reviewList = $("review-list");
  if (reviewList) reviewList.classList.remove("is-visible");

  const resultCard = $("result-card");
  if (resultCard) resultCard.classList.remove("is-visible");

  const slot = $("addr-slot");
  slot.dataset.initialized = "";
  slot.className = "address-wrap";
  slot.innerHTML = ADDRESS_FIELD_HTML;

  const activate = $("btn-activate");
  activate.classList.remove("btn--loading");
  activate.disabled = true;
  activate.textContent = "Activate Profile";

  setHint("");
  setPhoneHint("");
  resetDobPicker();
  document.querySelectorAll(".step").forEach((s) => {
    s.classList.remove("is-active", "is-leaving", "is-entering", "is-animating");
  });
  $("step-welcome").classList.add("is-active");
  updateProgressLabel();
}

function bindAccessibilityOther() {
  const field = $("accessibility-other-field");
  const input = $("accessibility-other");
  if (!field || !input) return;

  document.querySelectorAll('input[name="accessibility"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      const isOther = !!document.querySelector('input[name="accessibility"][value="other"]:checked');
      field.classList.toggle("is-open", isOther);
      if (isOther) input.focus();
    });
  });
}

function bindEvents() {
  $("btn-welcome").addEventListener("click", () => goToStep(1));
  $("btn-contact-next").addEventListener("click", goNext);
  $("btn-q1-next").addEventListener("click", goNext);
  $("btn-q7-next").addEventListener("click", goNext);
  $("btn-activate").addEventListener("click", fetchGuidance);
  $("btn-restart").addEventListener("click", resetForm);

  document.querySelectorAll("[data-next]").forEach((btn) => {
    btn.addEventListener("click", goNext);
  });

  document.querySelectorAll("[data-back]").forEach((btn) => {
    btn.addEventListener("click", goBack);
  });

  document.querySelectorAll(".choice input[type=radio]").forEach((input) => {
    input.addEventListener("change", () => {
      input.closest(".choices")?.querySelectorAll(".choice").forEach((l) => l.classList.remove("is-selected"));
      input.closest(".choice")?.classList.add("is-selected");
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  bindPhoneInput();
  bindDobPicker();
  bindAccessibilityOther();
  updateProgressLabel();
});
