const $ = (id) => document.getElementById(id);

// Base URL of the MCP/Poke bridge server (src/mcp-server.ts, default :3333). The app
// POSTs the onboarded profile here and polls /demo-state so the map, news feed, and
// tasks mirror what Poke sees as the scenario advances. Override via window.MCP_BASE.
const MCP_BASE = (window.MCP_BASE || "http://localhost:3333").replace(/\/$/, "");

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

const REVIEW_RADIO_OPTIONS = {
  vehicle_access: [
    { value: "yes", label: "Yes, I have a vehicle" },
    { value: "no", label: "No, I need transit or pickup" },
  ],
  vehicle_count: [
    { value: "1", label: "1 vehicle" },
    { value: "2", label: "2 vehicles" },
    { value: "3plus", label: "3 or more vehicles" },
  ],
  evacuating: [
    { value: "solo", label: "No — I'm evacuating alone" },
    { value: "small", label: "Yes, 1 to 2 dependents" },
    { value: "large", label: "Yes, 3 or more dependents" },
  ],
  vulnerable: [
    { value: "none", label: "None" },
    { value: "infants", label: "Yes, infants under 2" },
    { value: "seniors", label: "Yes, seniors 75+" },
    { value: "both", label: "Yes, both" },
  ],
  accessibility: [
    { value: "none", label: "None needed" },
    { value: "wheelchair", label: "Wheelchair accessible facility required" },
    { value: "medical", label: "Medical equipment power required" },
    { value: "other", label: "Other…" },
  ],
  animals: [
    { value: "none", label: "No pets" },
    { value: "pets", label: "Yes, bringing domestic pets" },
    { value: "service", label: "Certified service animal only" },
  ],
};

let openEditorKey = null;
let openEditorListId = null;
let reviewAddressSelection = null;

const PROFILE_KEYS = [
  { key: "name", label: "Name" },
  { key: "phone", label: "Mobile number" },
  { key: "birth_date", label: "Date of birth", readonly: true },
  ...REVIEW_KEYS,
];

const DEPENDENT_MOCK_DETAILS = [
  { name: "Maya", location: "140 Kupuohi St, Lahaina, HI 96761", lat: 20.8856, lng: -156.6694, status: "Needs pickup", dot: "warn", phone: "+1 (808) 555-0198" },
  { name: "Jordan", location: "45 Kaiwili St, Lahaina, HI 96761", lat: 20.8736, lng: -156.6761, status: "Safe", dot: "safe", phone: "+1 (808) 555-0144" },
  { name: "Sam", location: "225 Piikea Ave, Kihei, HI 96753", lat: 20.7547, lng: -156.4558, status: "Safe", dot: "safe", phone: "+1 (808) 555-0162" },
];

const DEFAULT_CHECKIN_MESSAGE = "Are you safe? Reply YES.";

const state = {
  step: 0,
  selectedAddress: null,
  data: {},
  guidance: null,
  platformTab: "home",
  updateFilter: "all",
  homeUpdateFilter: "all",
  cachedAlerts: [],
  invitedMembers: [],
  prepChecked: {},
  checkinMessage: DEFAULT_CHECKIN_MESSAGE,
  showEvacuationRoute: false,
  mapRouteLineVisible: false,
  routeDestination: null,
  routeSource: null,
  shelters: null,
  mapFullscreenOpen: false,
  selectedMapMemberId: null,
  leaflet: {
    preview: null,
    fullscreen: null,
    layers: { preview: null, fullscreen: null },
  },
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

    target.classList.add("is-active", "is-animating");
    await triggerEnterAnimation(target);
    target.classList.remove("is-animating");

    if (next === 2) initAddress();
    if (next === 10) {
      renderReview();
      revealReviewList();
    }
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
    const firstNameVal = $("first-name").value.trim();
    const lastNameVal = $("last-name").value.trim();
    const phone = $("phone").value.trim();
    if (!firstNameVal) {
      $("first-name").focus();
      return false;
    }
    if (!lastNameVal) {
      $("last-name").focus();
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
    state.data.first_name = firstNameVal;
    state.data.last_name = lastNameVal;
    state.data.name = `${firstNameVal} ${lastNameVal}`;
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

function bindScopedAddressAutocomplete({ input, list, getSelected, setSelected, onHint }) {
  if (!input || !list) return;

  let suggestTimer = null;
  let activeIndex = -1;
  let suggestions = [];
  let fetchAbort = null;

  const setHintLocal = (msg, isError = false) => {
    if (onHint) onHint(msg, isError);
  };

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
    setSelected({ address: item.label, lat: item.lat, lng: item.lng });
    input.value = item.label;
    hideList();
    setHintLocal("Selected: " + item.label);
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
    const sel = getSelected();
    if (sel && sel.address !== input.value) {
      setSelected(null);
    }
    if (q.length < 2) {
      hideList();
      setHintLocal("Start typing your US address.");
      return;
    }
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => fetchSuggestions(q), 250);
    setHintLocal("Pick your address from the list.");
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
    if (q.length >= 2 && !getSelected()) fetchSuggestions(q);
  });
}

function bindAddressAutocomplete() {
  const input = $("address");
  const list = $("addr-suggestions");
  if (!input || !list) return;

  bindScopedAddressAutocomplete({
    input,
    list,
    getSelected: () => state.selectedAddress,
    setSelected: (sel) => {
      if (sel) {
        state.selectedAddress = sel;
        state.data.address = sel.address;
      } else {
        state.selectedAddress = null;
      }
    },
    onHint: (msg, isError) => setHint(msg, isError),
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
  if (key === "name") return fullName(state.data);
  if (key === "phone") return state.data.phone || "—";
  if (key === "birth_date") {
    if (!state.data.birth_date) return "—";
    const age = state.data.age != null ? ` · Age ${state.data.age}` : "";
    return `${state.data.birth_date}${age}`;
  }
  if (key === "address") return state.data.address || "—";
  if (key === "accessibility" && val === "other") return state.data.accessibility_other || "Other";
  const map = DISPLAY[key];
  return map?.[val] || val || "—";
}

function getEditItem(key, listId) {
  return document.querySelector(`#${listId} .review-item[data-review-key="${key}"]`);
}

function renderReview() {
  const list = $("review-list");
  openEditorKey = null;
  openEditorListId = null;
  reviewAddressSelection = null;
  list.classList.remove("is-visible");
  list.innerHTML = REVIEW_KEYS.map(({ key, label }, i) => {
    const value = displayValue(key);
    return `<li class="review-item" data-review-key="${key}" style="--i: ${i}">
      <div class="review-item__main">
        <label class="review-item__label">
          <input type="checkbox" class="review-item__check" data-review-key="${key}">
          <span class="review-item__content">
            <span class="review-item__title">${escapeHtml(label)}</span>
            <span class="review-item__value">${escapeHtml(value)}</span>
          </span>
        </label>
        <button type="button" class="review-item__edit" data-review-edit="${key}" aria-label="Edit ${escapeHtml(label)}">Edit</button>
      </div>
      <div class="review-item__editor" hidden></div>
    </li>`;
  }).join("");

  $("btn-activate").disabled = true;
  list.querySelectorAll(".review-item__check").forEach((cb) => {
    cb.addEventListener("change", updateActivateButton);
  });
}

function buildReviewEditorHtml(key) {
  if (key === "name") {
    return `<div class="review-editor">
      <div class="name-fields">
        <div class="field">
          <label>First name</label>
          <input type="text" class="review-editor__text-input" data-profile-field="first_name" value="${escapeHtml(state.data.first_name || "")}" placeholder="First">
        </div>
        <div class="field">
          <label>Last name</label>
          <input type="text" class="review-editor__text-input" data-profile-field="last_name" value="${escapeHtml(state.data.last_name || "")}" placeholder="Last">
        </div>
      </div>
      <button type="button" class="btn btn--primary btn--sm review-editor__done">Save</button>
    </div>`;
  }
  if (key === "phone") {
    return `<div class="review-editor">
      <div class="field">
        <input type="tel" class="review-editor__text-input" data-profile-field="phone" value="${escapeHtml(state.data.phone || "")}" placeholder="+1 (555) 000-0000">
      </div>
      <button type="button" class="btn btn--primary btn--sm review-editor__done">Save</button>
    </div>`;
  }
  if (key === "address") {
    return `
      <div class="review-editor review-editor--address">
        <div class="field field--address">
          <input type="text" class="review-editor__address-input" placeholder="e.g. 123 Main St, Lahaina, HI" autocomplete="off" aria-autocomplete="list" value="${escapeHtml(state.data.address || "")}">
          <ul class="addr-suggestions review-editor__suggestions" hidden role="listbox" aria-label="Address suggestions"></ul>
        </div>
        <p class="hint review-editor__hint"></p>
        <button type="button" class="btn btn--primary btn--sm review-editor__done">Save address</button>
      </div>`;
  }

  const options = REVIEW_RADIO_OPTIONS[key];
  if (!options) return "";

  const current = state.data[key];
  const choices = options
    .map(
      (o) => `<label class="choice${current === o.value ? " is-selected" : ""}">
      <input type="radio" name="review-edit-${key}" value="${o.value}"${current === o.value ? " checked" : ""}>
      <span>${escapeHtml(o.label)}</span>
    </label>`
    )
    .join("");

  let otherHtml = "";
  if (key === "accessibility") {
    const isOther = current === "other";
    otherHtml = `
      <div class="accessibility-other review-editor__other${isOther ? " is-open" : ""}">
        <div class="accessibility-other__inner">
          <div class="field">
            <label>Describe your requirement</label>
            <input type="text" class="review-editor__accessibility-other" placeholder="e.g. sign language interpreter, oxygen tank storage" value="${escapeHtml(state.data.accessibility_other || "")}">
          </div>
        </div>
      </div>
      <button type="button" class="btn btn--primary btn--sm review-editor__done review-editor__done--accessibility"${isOther ? "" : " hidden"}>Save</button>`;
  }

  return `<div class="review-editor review-editor--choices">
    <div class="choices" role="radiogroup">${choices}</div>
    ${otherHtml}
  </div>`;
}

function updateEditableItemValue(key, listId) {
  const item = getEditItem(key, listId);
  if (!item) return;
  const valueEl = item.querySelector(".review-item__value");
  if (valueEl) valueEl.textContent = displayValue(key);
}

function updateReviewItemValue(key) {
  updateEditableItemValue(key, "review-list");
}

function updateProfileItemValue(key) {
  updateEditableItemValue(key, "profile-list");
}

function uncheckReviewItem(key) {
  const cb = document.querySelector(`.review-item__check[data-review-key="${key}"]`);
  if (cb) {
    cb.checked = false;
    updateActivateButton();
  }
}

function syncMainFormField(key, value) {
  if (key === "address") {
    const input = $("address");
    if (input) input.value = state.data.address || "";
    return;
  }

  if (key === "accessibility") {
    document.querySelectorAll('input[name="accessibility"]').forEach((radio) => {
      radio.checked = radio.value === value;
      radio.closest(".choice")?.classList.toggle("is-selected", radio.checked);
    });
    const field = $("accessibility-other-field");
    const otherInput = $("accessibility-other");
    if (value === "other") {
      field?.classList.add("is-open");
      if (otherInput && state.data.accessibility_other) {
        otherInput.value = state.data.accessibility_other;
      }
    } else {
      field?.classList.remove("is-open");
      if (otherInput) otherInput.value = "";
    }
    return;
  }

  document.querySelectorAll(`input[name="${key}"]`).forEach((radio) => {
    radio.checked = radio.value === value;
    radio.closest(".choice")?.classList.toggle("is-selected", radio.checked);
  });
}

function closeEditor(key, listId = openEditorListId) {
  const item = getEditItem(key, listId);
  if (!item) return;
  const editor = item.querySelector(".review-item__editor");
  editor.hidden = true;
  editor.innerHTML = "";
  item.classList.remove("is-editing");
  if (openEditorKey === key && openEditorListId === listId) {
    openEditorKey = null;
    openEditorListId = null;
  }
  if (key === "address") reviewAddressSelection = null;
}

function closeReviewEditor(key) {
  closeEditor(key, "review-list");
}

function openEditor(key, listId) {
  if (openEditorKey && (openEditorKey !== key || openEditorListId !== listId)) {
    closeEditor(openEditorKey, openEditorListId);
  }

  const item = getEditItem(key, listId);
  if (!item) return;

  const editor = item.querySelector(".review-item__editor");
  editor.innerHTML = buildReviewEditorHtml(key);
  editor.hidden = false;
  item.classList.add("is-editing");
  openEditorKey = key;
  openEditorListId = listId;

  if (key === "address") {
    reviewAddressSelection = state.selectedAddress ? { ...state.selectedAddress } : null;
    const input = editor.querySelector(".review-editor__address-input");
    const list = editor.querySelector(".review-editor__suggestions");
    const hint = editor.querySelector(".review-editor__hint");
    bindScopedAddressAutocomplete({
      input,
      list,
      getSelected: () => reviewAddressSelection,
      setSelected: (sel) => {
        reviewAddressSelection = sel;
      },
      onHint: (msg, isError) => {
        if (!hint) return;
        hint.textContent = msg;
        hint.classList.toggle("is-error", isError);
      },
    });
    input?.focus();
  } else {
    editor.querySelector(".review-editor__text-input")?.focus();
  }

  bindEditorEvents(item, key, listId);
}

function openReviewEditor(key) {
  openEditor(key, "review-list");
}

function toggleEditor(key, listId) {
  if (openEditorKey === key && openEditorListId === listId) closeEditor(key, listId);
  else openEditor(key, listId);
}

function toggleReviewEditor(key) {
  toggleEditor(key, "review-list");
}

function refreshPlatformAfterProfileEdit() {
  renderMapPins();
  renderMapRoute();
  renderFamilyScroll();
  renderFamilyView();
  renderPrepList();
  const greeting = $("platform-greeting");
  const avatar = $("platform-avatar");
  if (greeting) greeting.textContent = `Hi, ${firstName(state.data.first_name || state.data.name)}`;
  if (avatar) avatar.textContent = initials(fullName(state.data));
}

function applyFieldEdit(key, value, listId) {
  state.data[key] = value;

  if (key === "vehicle_access" && value === "no") {
    state.data.vehicle_count = "na";
    syncMainFormField("vehicle_count", "na");
    updateEditableItemValue("vehicle_count", listId);
    if (listId === "review-list") uncheckReviewItem("vehicle_count");
  }

  if (key === "accessibility" && value !== "other") {
    delete state.data.accessibility_other;
  }

  syncMainFormField(key, value);
  updateEditableItemValue(key, listId);
  if (listId === "review-list") uncheckReviewItem(key);
  closeEditor(key, listId);

  if (listId === "profile-list") refreshPlatformAfterProfileEdit();

  if (listId === "review-list" && key === "vehicle_access" && value === "yes" && state.data.vehicle_count === "na") {
    requestAnimationFrame(() => openReviewEditor("vehicle_count"));
  }
}

function applyReviewField(key, value) {
  applyFieldEdit(key, value, "review-list");
}

function applyFieldAddress(item, listId) {
  const hint = item.querySelector(".review-editor__hint");
  if (!reviewAddressSelection?.address) {
    if (hint) {
      hint.textContent = "Choose an address from the suggestions.";
      hint.classList.add("is-error");
    }
    return;
  }
  state.selectedAddress = { ...reviewAddressSelection };
  state.data.address = reviewAddressSelection.address;
  syncMainFormField("address");
  updateEditableItemValue("address", listId);
  if (listId === "review-list") uncheckReviewItem("address");
  closeEditor("address", listId);
  if (listId === "profile-list") refreshPlatformAfterProfileEdit();
}

function applyFieldAccessibility(item, listId) {
  const editor = item.querySelector(".review-item__editor");
  const otherInput = editor.querySelector(".review-editor__accessibility-other");
  const text = otherInput?.value?.trim() || "";
  if (!text) {
    otherInput?.focus();
    return;
  }
  state.data.accessibility = "other";
  state.data.accessibility_other = text;
  syncMainFormField("accessibility", "other");
  const mainOther = $("accessibility-other");
  if (mainOther) mainOther.value = text;
  updateEditableItemValue("accessibility", listId);
  if (listId === "review-list") uncheckReviewItem("accessibility");
  closeEditor("accessibility", listId);
  if (listId === "profile-list") refreshPlatformAfterProfileEdit();
}

function applyProfileTextField(item, key, listId) {
  if (key === "name") {
    const first = item.querySelector('[data-profile-field="first_name"]')?.value.trim() || "";
    const last = item.querySelector('[data-profile-field="last_name"]')?.value.trim() || "";
    if (!first) {
      item.querySelector('[data-profile-field="first_name"]')?.focus();
      return;
    }
    if (!last) {
      item.querySelector('[data-profile-field="last_name"]')?.focus();
      return;
    }
    state.data.first_name = first;
    state.data.last_name = last;
    state.data.name = `${first} ${last}`;
    $("first-name").value = first;
    $("last-name").value = last;
    updateEditableItemValue(key, listId);
    closeEditor(key, listId);
    refreshPlatformAfterProfileEdit();
    return;
  }

  const input = item.querySelector(`[data-profile-field="${key}"]`);
  if (!input) return;
  if (key === "phone") {
    const phone = input.value.trim();
    if (!isPhoneComplete(phone)) {
      input.focus();
      return;
    }
    state.data.phone = formatPhoneDisplay(phone);
    $("phone").value = state.data.phone;
  }
  updateEditableItemValue(key, listId);
  closeEditor(key, listId);
  refreshPlatformAfterProfileEdit();
}

function bindEditorEvents(item, key, listId) {
  const editor = item.querySelector(".review-item__editor");

  editor.querySelectorAll(".choice input[type=radio]").forEach((input) => {
    input.addEventListener("change", () => {
      editor.querySelectorAll(".choice").forEach((l) => l.classList.remove("is-selected"));
      input.closest(".choice")?.classList.add("is-selected");

      if (key === "accessibility" && input.value === "other") {
        editor.querySelector(".review-editor__other")?.classList.add("is-open");
        editor.querySelector(".review-editor__done--accessibility")?.removeAttribute("hidden");
        editor.querySelector(".review-editor__accessibility-other")?.focus();
        return;
      }

      if (key === "accessibility") {
        editor.querySelector(".review-editor__other")?.classList.remove("is-open");
        editor.querySelector(".review-editor__done--accessibility")?.setAttribute("hidden", "");
      }

      applyFieldEdit(key, input.value, listId);
    });
  });

  editor.querySelector(".review-editor__done")?.addEventListener("click", () => {
    if (key === "address") applyFieldAddress(item, listId);
    else if (key === "accessibility") applyFieldAccessibility(item, listId);
    else if (key === "name" || key === "phone") applyProfileTextField(item, key, listId);
  });
}

function bindEditableList(listId, editAttr) {
  const list = document.getElementById(listId);
  if (!list || list.dataset.bound === "1") return;
  list.dataset.bound = "1";
  list.addEventListener("click", (e) => {
    const editBtn = e.target.closest(`[${editAttr}]`);
    if (!editBtn) return;
    e.preventDefault();
    e.stopPropagation();
    const key = editBtn.getAttribute(editAttr);
    toggleEditor(key, listId);
  });
}

function bindReviewList() {
  bindEditableList("review-list", "data-review-edit");
}

function bindProfileList() {
  bindEditableList("profile-list", "data-profile-edit");
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
    name: fullName(d),
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

function fullName(data) {
  const first = data?.first_name?.trim();
  const last = data?.last_name?.trim();
  if (first && last) return `${first} ${last}`;
  return data?.name?.trim() || "—";
}

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0]?.[0] || "?").toUpperCase();
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "there";
}

function buildFamilyMembers() {
  const d = state.data;
  const home = getUserGeo();
  const members = [
    {
      id: "user",
      name: fullName(d) || "You",
      phone: d.phone || "",
      status: "Safe",
      detail: shortAddress(d.address),
      location: d.address || shortAddress(d.address),
      lat: home.lat,
      lng: home.lng,
      dot: "safe",
      isYou: true,
      lastSeen: "Just now",
    },
  ];

  const depCount = d.evacuating === "small" ? 2 : d.evacuating === "large" ? 3 : 0;
  for (let i = 0; i < depCount; i++) {
    const mock = DEPENDENT_MOCK_DETAILS[i] || DEPENDENT_MOCK_DETAILS[0];
    members.push({
      id: `dep-${i + 1}`,
      name: mock.name,
      phone: mock.phone || "",
      status: mock.status,
      detail: mock.location,
      location: mock.location,
      lat: mock.lat,
      lng: mock.lng,
      dot: mock.dot,
      isYou: false,
      lastSeen: i === 0 ? "8 min ago" : "12 min ago",
    });
  }

  state.invitedMembers.forEach((inv, i) => {
    members.push({
      id: `inv-${i}`,
      name: inv.name,
      phone: inv.phone,
      status: "Invite pending",
      detail: "Awaiting response",
      location: "Location pending",
      lat: home.lat + 0.003 * (i + 1),
      lng: home.lng + 0.0025 * (i + 1),
      dot: "transit",
      isYou: false,
      invited: true,
      lastSeen: "—",
    });
  });

  return members;
}

function needsAttention() {
  const d = state.data;
  return (
    (d.vulnerable && d.vulnerable !== "none") ||
    (d.accessibility && d.accessibility !== "none") ||
    d.evacuating === "small" ||
    d.evacuating === "large"
  );
}

const UPDATE_SOURCE_URLS = [
  ["national weather service", "https://www.weather.gov/hfo/"],
  ["maui county", "https://www.mauicounty.gov/983/MEMA-Alerts"],
  ["county civil defense", "https://www.mauicounty.gov/983/MEMA-Alerts"],
  ["civil defense", "https://www.mauicounty.gov/983/MEMA-Alerts"],
  ["wireless emergency alert", "https://www.fcc.gov/consumers/guides/wireless-emergency-alerts-wea"],
  ["maui fire", "https://www.mauifire.gov/"],
  ["maui now", "https://mauinow.com/2021/03/08/breaking-maui-kaupakalua-dam-overflows-evacuations-ordered-haiku/"],
  ["maui news", "https://www.mauinews.com/news/local-news/2021/03/water-crests-dam-destroys-bridge-and-damages-homes/"],
  ["hawaii news now", "https://www.hawaiinewsnow.com/2021/03/08/flash-flood-watch-issued-big-island-maui-county/"],
  ["civil beat", "https://civilbeat.org/2021/03/maui-area-evacuated-after-heavy-rains-cause-dam-to-overflow/"],
  ["honolulu star-advertiser", "https://www.staradvertiser.com/"],
];

function getUpdateArticleUrl(alert) {
  if (alert?.url) return alert.url;
  if (alert?.article_url) return alert.article_url;
  const src = String(alert?.source || "");
  if (/^https?:\/\//i.test(src)) return src;
  const lower = src.toLowerCase();
  for (const [needle, url] of UPDATE_SOURCE_URLS) {
    if (lower.includes(needle)) return url;
  }
  return null;
}

function getUpdateSourceLabel(alert) {
  const src = String(alert?.source || "Official source");
  if (/^https?:\/\//i.test(src)) {
    try {
      return new URL(src).hostname.replace(/^www\./, "");
    } catch {
      return "Official source";
    }
  }
  return src;
}

function renderUpdateSourceHead(alert) {
  const label = escapeHtml(getUpdateSourceLabel(alert));
  const url = getUpdateArticleUrl(alert);
  if (!url) return `<p class="update-card__source">${label}</p>`;
  const safeUrl = escapeHtml(url);
  const aria = escapeHtml(`Read full article at ${getUpdateSourceLabel(alert)} (opens in new tab)`);
  return `<p class="update-card__source"><a href="${safeUrl}" class="update-card__source-link" target="_blank" rel="noopener noreferrer" aria-label="${aria}">${label}</a></p>`;
}

function renderUpdateReadMore(alert) {
  const url = getUpdateArticleUrl(alert);
  if (!url) return "";
  const safeUrl = escapeHtml(url);
  const aria = escapeHtml(`Read full article from ${getUpdateSourceLabel(alert)} (opens in new tab)`);
  return `<a href="${safeUrl}" class="update-card__read-more" target="_blank" rel="noopener noreferrer" aria-label="${aria}">Read full article<span aria-hidden="true"> →</span></a>`;
}

function categorizeUpdate(alert) {
  const text = `${alert.event} ${alert.text} ${alert.area}`.toLowerCase();
  if (/flood|weather|rain|storm|wind/.test(text)) return "weather";
  if (/road|highway|route|transit|traffic/.test(text)) return "roads";
  return "safety";
}

function updateUrgencyScore(alert) {
  const sev = String(alert.severity || "").toLowerCase();
  const sevScore =
    { extreme: 4, severe: 3, moderate: 2, minor: 1, info: 0, unknown: 0 }[sev] ?? 0;
  const text = `${alert.event} ${alert.text}`.toLowerCase();
  let keywordBoost = 0;
  if (/mandatory|evacuat|emergency/.test(text)) keywordBoost += 3;
  if (/warning/.test(text)) keywordBoost += 2;
  if (/advisory/.test(text)) keywordBoost += 0.5;
  const catBoost = categorizeUpdate(alert) === "safety" ? 1 : 0;
  return sevScore * 10 + keywordBoost + catBoost;
}

function sortUpdatesByPriority(alerts) {
  return alerts
    .map((alert, index) => ({ alert, index, score: updateUrgencyScore(alert) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.alert);
}

function updateTimeLabel(alert, allAlerts) {
  const times = ["2m ago", "15m ago", "1h ago", "3h ago", "6h ago"];
  const index = allAlerts.indexOf(alert);
  return index >= 0 ? times[index] || "Recently" : "Recently";
}

function getUserLocationContext() {
  const guidance = state.guidance;
  const address = (guidance?.resolved?.address || state.data?.address || "").toLowerCase();
  const zone = (guidance?.zone || "").toLowerCase();
  return { address, zone, guidance };
}

function alertAreaMatchesUser(alert) {
  const { address, zone } = getUserLocationContext();
  const area = (alert.area || "").toLowerCase();
  if (!area) return true;

  const zoneRoot = zone.split("-")[0];
  if (zoneRoot && area.includes(zoneRoot)) return true;

  const placeTokens = ["lahaina", "kihei", "west maui", "central maui", "wailuku", "paia"];
  for (const place of placeTokens) {
    if (area.includes(place) && address.includes(place)) return true;
  }

  if (/maui/i.test(area) && /hi\b|maui/i.test(address)) return true;
  return false;
}

function parseAlertAction(alert) {
  const text = `${alert.event} ${alert.text}`.toLowerCase();
  if (/shelter in place|do not evacuat|stay indoors|remain in place/.test(text)) return "shelter";
  if (/evacuat|higher ground|low-lying|leave immediately|move to .*shelter|designated shelter/.test(text)) {
    return "evacuate";
  }
  if (/avoid .* highway|road closure|flooding reported/.test(text)) return "route";
  return null;
}

function getUpdatePersonalStatus(alert) {
  const action = parseAlertAction(alert);
  if (!action) return null;

  const { guidance } = getUserLocationContext();
  // During an active evacuation that applies to the user, treat every serious update
  // as relevant. Otherwise per-card area matching can wrongly say "you're OK here"
  // and contradict the headline evacuation guidance.
  const activeEvac =
    !!guidance &&
    guidance.fail_safe !== true &&
    guidance.applies_to_user !== false &&
    /evacuat|leave|higher ground|move now|head to|get to/.test((guidance.recommended_action || "").toLowerCase());
  const affectsUser = alertAreaMatchesUser(alert) || activeEvac;

  if (action === "route") {
    if (!affectsUser) {
      return {
        status: "ok",
        label: "You're OK where you are",
        detail: "This route advisory doesn't cover your area.",
      };
    }
    return {
      status: "monitor",
      label: "Check your route",
      detail: "Your location may be fine, but avoid affected roads.",
    };
  }

  if (!guidance) {
    return affectsUser
      ? {
          status: "monitor",
          label: "Check if this applies to you",
          detail: "Activate your profile for personalized guidance.",
        }
      : {
          status: "ok",
          label: "You're OK where you are",
          detail: "This update doesn't appear to cover your area.",
        };
  }

  if (guidance.fail_safe) {
    return {
      status: "monitor",
      label: "Follow official guidance",
      detail: "Alerts conflict — confirm with county channels before moving.",
    };
  }

  if (!affectsUser) {
    return {
      status: "ok",
      label: "You're OK where you are",
      detail: "Your address isn't in the area this update describes.",
    };
  }

  const recommended = (guidance.recommended_action || "").toLowerCase();

  if (action === "evacuate") {
    if (guidance.applies_to_user === false || /no active evacuation|stay alert/.test(recommended)) {
      return {
        status: "ok",
        label: "You're OK where you are",
        detail: guidance.recommended_action || "No evacuation order applies to your address right now.",
      };
    }
    if (/evacuat|higher ground|leave|move/.test(recommended) || guidance.applies_to_user === true) {
      return {
        status: "move",
        label: "You need to move",
        detail: guidance.recommended_action || "Leave for a safer location per official guidance.",
      };
    }
  }

  if (action === "shelter") {
    if (/shelter|stay|remain|do not leave/.test(recommended)) {
      return {
        status: "ok",
        label: "You're OK where you are",
        detail: guidance.recommended_action || "Shelter in place applies to your location.",
      };
    }
    if (/evacuat|leave|higher ground/.test(recommended)) {
      return {
        status: "move",
        label: "You need to move",
        detail: guidance.recommended_action || "Your guidance says to evacuate, not shelter in place.",
      };
    }
  }

  return affectsUser
    ? {
        status: "monitor",
        label: "Monitor closely",
        detail: "Watch for changes that apply to your area.",
      }
    : {
        status: "ok",
        label: "You're OK where you are",
        detail: "This update doesn't appear to cover your area.",
      };
}

function renderUpdatePersonalStatus(alert) {
  const personal = getUpdatePersonalStatus(alert);
  if (!personal) return "";

  const routeBtn =
    personal.status === "move"
      ? `<button type="button" class="update-card__route-btn" data-view-route>View route</button>`
      : "";

  const headClass = routeBtn ? " update-card__personal-head--with-action" : "";

  return `
      <div class="update-card__personal update-card__personal--${escapeHtml(personal.status)}" role="status">
        <div class="update-card__personal-head${headClass}">
          <div class="update-card__personal-copy">
            <p class="update-card__personal-label">For you</p>
            <p class="update-card__personal-action">${escapeHtml(personal.label)}</p>
          </div>
          ${routeBtn}
        </div>
        <p class="update-card__personal-detail">${escapeHtml(personal.detail)}</p>
      </div>`;
}

const MAP_TILE_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
const MAP_TILE_OPTS = {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; CARTO',
  subdomains: "abcd",
  maxZoom: 19,
};

function memberMarkerHtml(member) {
  const cls =
    member.isYou ? "map-member-marker__bubble--you" :
    member.dot === "warn" ? "map-member-marker__bubble--warn" : "";
  const label = member.isYou ? "You" : initials(member.name);
  return `<div class="map-member-marker__bubble ${cls}" aria-hidden="true">${escapeHtml(label)}</div>`;
}

function createMemberIcon(member) {
  const markerClass = member.isYou
    ? "map-member-marker map-member-marker--you"
    : `map-member-marker map-member-marker--${member.dot}`;
  return L.divIcon({
    className: markerClass,
    html: memberMarkerHtml(member),
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}

function getLeafletLayers(key) {
  const existing = state.leaflet.layers[key];
  if (!existing?.markers) {
    state.leaflet.layers[key] = {
      markers: L.layerGroup(),
      route: L.layerGroup(),
      shelter: L.layerGroup(),
    };
  }
  return state.leaflet.layers[key];
}

function destroyLeafletMap(key) {
  const map = state.leaflet[key];
  if (map) {
    map.remove();
    state.leaflet[key] = null;
    state.leaflet.layers[key] = null;
  }
}

function createLeafletMap(containerId, { interactive }) {
  if (typeof L === "undefined") return null;
  const center = getUserGeo();
  const map = L.map(containerId, {
    center: [center.lat, center.lng],
    zoom: 13,
    zoomControl: false,
    attributionControl: interactive,
    dragging: interactive,
    touchZoom: interactive,
    doubleClickZoom: interactive,
    scrollWheelZoom: interactive,
    boxZoom: interactive,
    keyboard: interactive,
  });
  L.tileLayer(MAP_TILE_URL, MAP_TILE_OPTS).addTo(map);
  const layers = getLeafletLayers(containerId === "home-map-preview" ? "preview" : "fullscreen");
  layers.markers.addTo(map);
  layers.route.addTo(map);
  layers.shelter.addTo(map);
  return map;
}

function syncMapMarkers(key) {
  const mapKey = key === "fullscreen" ? "fullscreen" : "preview";
  const map = state.leaflet[mapKey];
  if (!map) return;
  const layers = getLeafletLayers(mapKey);
  layers.markers.clearLayers();
  const members = buildFamilyMembers();
  const bounds = [];

  for (const member of members) {
    if (typeof member.lat !== "number" || typeof member.lng !== "number") continue;
    bounds.push([member.lat, member.lng]);
    const marker = L.marker([member.lat, member.lng], {
      icon: createMemberIcon(member),
      riseOnHover: true,
    });
    if (mapKey === "fullscreen") {
      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        if (member.isYou) {
          hideMapPersonCard();
          showMapGuidanceCard();
        } else {
          showMapPersonCard(member);
        }
      });
    }
    marker.addTo(layers.markers);
  }

  if (bounds.length) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: mapKey === "preview" ? 13 : 14 });
  } else {
    const c = getUserGeo();
    map.setView([c.lat, c.lng], 13);
  }
}

function syncMapRoute() {
  const keys = ["preview", "fullscreen"];
  for (const mapKey of keys) {
    const map = state.leaflet[mapKey];
    if (!map) continue;
    const layers = getLeafletLayers(mapKey);
    layers.route.clearLayers();
    layers.shelter.clearLayers();

    if (!state.showEvacuationRoute) continue;

    const dest = getRouteDestination();
    const geo = getUserGeo();
    if (typeof dest.lat === "number" && typeof dest.lng === "number") {
      if (state.mapRouteLineVisible) {
        L.polyline(
          [[geo.lat, geo.lng], [dest.lat, dest.lng]],
          { color: "#c45c48", weight: 5, opacity: 0.9, dashArray: "8 6", lineCap: "round" }
        ).addTo(layers.route);
      }
      L.marker([dest.lat, dest.lng], {
        icon: L.divIcon({
          className: "map-member-marker",
          html: '<div class="map-member-marker__bubble map-member-marker__bubble--warn">S</div>',
          iconSize: [44, 44],
          iconAnchor: [22, 22],
        }),
      }).addTo(layers.shelter);
    }
  }
  renderHomeRouteBanner();
}

function renderHomeRouteBanner() {
  const el = $("home-route-banner");
  if (!el) return;
  if (!state.showEvacuationRoute) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const dest = getRouteDestination();
  const routeTitle = state.routeSource === "nearest" ? "Nearest shelter" : "Evacuation route";
  const distanceLine = dest.distanceMi ? `${dest.distanceMi} mi away · ` : "";
  const directions = dest.directions || state.guidance?.how_to_get_there || "Follow designated evacuation routes.";
  el.hidden = false;
  el.innerHTML = `
    <p class="home-route-banner__title">${escapeHtml(routeTitle)}</p>
    <p class="home-route-banner__dest">${escapeHtml(dest.label || "Shelter")}</p>
    <p>${escapeHtml(distanceLine)}${escapeHtml(directions)}</p>
    ${!state.mapRouteLineVisible ? '<button type="button" class="map-person-card__btn map-person-card__btn--primary" id="btn-home-view-route" style="margin-top:0.75rem;width:100%">View route on map</button>' : ""}
  `;
  $("btn-home-view-route")?.addEventListener("click", () => {
    state.mapRouteLineVisible = true;
    openMapFullscreen();
    syncMapRoute();
  });
}

function initMapPreview() {
  if (typeof L === "undefined") return;
  const container = $("home-map-preview");
  if (!container || state.leaflet.preview) return;
  try {
    destroyLeafletMap("preview");
    const map = createLeafletMap("home-map-preview", { interactive: false });
    if (!map) return;
    state.leaflet.preview = map;
    syncMapMarkers("preview");
    syncMapRoute();
    setTimeout(() => map.invalidateSize(), 120);
  } catch (err) {
    console.error("Map preview failed to load", err);
  }
}

function openMapFullscreen() {
  const overlay = $("map-fullscreen");
  if (!overlay) return;
  overlay.hidden = false;
  state.mapFullscreenOpen = true;
  $("app")?.classList.add("is-map-fullscreen");
  document.body.style.overflow = "hidden";

  destroyLeafletMap("fullscreen");
  const map = createLeafletMap("map-fullscreen-container", { interactive: true });
  state.leaflet.fullscreen = map;
  syncMapMarkers("fullscreen");
  syncMapRoute();

  setTimeout(() => {
    map?.invalidateSize();
    const members = buildFamilyMembers();
    const bounds = members.filter((m) => typeof m.lat === "number").map((m) => [m.lat, m.lng]);
    if (bounds.length) map.fitBounds(bounds, { padding: [48, 48], maxZoom: 14 });
  }, 80);
}

function closeMapFullscreen() {
  const overlay = $("map-fullscreen");
  if (!overlay) return;
  overlay.hidden = true;
  state.mapFullscreenOpen = false;
  $("app")?.classList.remove("is-map-fullscreen");
  hideMapPersonCard();
  document.body.style.overflow = "";
  destroyLeafletMap("fullscreen");
  syncMapMarkers("preview");
  syncMapRoute();
}

function hideMapPersonCard() {
  const card = $("map-person-card");
  if (!card) return;
  card.hidden = true;
  card.innerHTML = "";
  state.selectedMapMemberId = null;
}

function mapsDirectionsUrl(lat, lng) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${lat},${lng}`)}`;
}

function showMapGuidanceCard() {
  const card = $("map-person-card");
  const g = state.guidance;
  if (!card || !g) return;
  card.className = "map-person-card map-guidance-card";
  card.hidden = false;
  const action = g.recommended_action || "Follow official guidance.";
  const dest = g.destination ? `Shelter: ${g.destination}` : "";
  card.innerHTML = `
    <div class="map-person-card__head">
      <div class="map-person-card__avatar map-member-marker__bubble--you">${escapeHtml(initials(fullName(state.data)))}</div>
      <div class="map-person-card__meta">
        <p class="map-person-card__name">Your guidance</p>
        <p class="map-person-card__status">${escapeHtml(action)}</p>
        ${dest ? `<p class="map-person-card__detail">${escapeHtml(dest)}</p>` : ""}
      </div>
      <button type="button" class="map-person-card__close" id="map-person-card-close" aria-label="Close">×</button>
    </div>
    <div class="map-person-card__actions">
      <button type="button" class="map-person-card__btn map-person-card__btn--primary" id="map-guidance-route-btn">View evacuation route</button>
      <button type="button" class="map-person-card__btn" id="map-guidance-close-btn">Close</button>
    </div>
  `;
  $("map-person-card-close")?.addEventListener("click", hideMapPersonCard);
  $("map-guidance-close-btn")?.addEventListener("click", hideMapPersonCard);
  $("map-guidance-route-btn")?.addEventListener("click", async () => {
    hideMapPersonCard();
    await showGuidanceRoute();
    syncMapRoute();
  });
}

function showMapPersonCard(member) {
  const card = $("map-person-card");
  if (!card || member.isYou) return;
  state.selectedMapMemberId = member.id;
  const cardTheme =
    member.dot === "warn" ? " map-person-card--warn" :
    member.dot === "safe" ? " map-person-card--safe" : "";
  card.className = `map-person-card${cardTheme}`;
  card.hidden = false;

  const statusClass =
    member.dot === "warn" ? "map-person-card__status--warn" :
    member.dot === "safe" ? "map-person-card__status--safe" : "";
  const avatarClass =
    member.dot === "warn" ? " map-person-card__avatar--warn" :
    member.dot === "safe" ? " map-person-card__avatar--safe" : "";
  const phone = member.phone ? member.phone.replace(/\D/g, "").length >= 10 : false;
  const tel = phone ? `tel:${member.phone.replace(/[^\d+]/g, "")}` : "";
  const dirUrl = mapsDirectionsUrl(member.lat, member.lng);

  card.innerHTML = `
    <div class="map-person-card__head">
      <div class="map-person-card__avatar${avatarClass}">${escapeHtml(initials(member.name))}</div>
      <div class="map-person-card__meta">
        <p class="map-person-card__name">${escapeHtml(member.name)}</p>
        <p class="map-person-card__status ${statusClass}">${escapeHtml(member.status)}</p>
        <p class="map-person-card__detail">${escapeHtml(member.location)}</p>
        <p class="map-person-card__seen">Last seen · ${escapeHtml(member.lastSeen || "Recently")}</p>
      </div>
      <button type="button" class="map-person-card__close" id="map-person-card-close" aria-label="Close">×</button>
    </div>
    <div class="map-person-card__actions">
      ${phone ? `<a class="map-person-card__btn" href="${escapeHtml(tel)}">Call</a>` : ""}
      <button type="button" class="map-person-card__btn" data-map-checkin="${escapeHtml(member.id)}">Check-in</button>
      <button type="button" class="map-person-card__btn" data-map-directions="${escapeHtml(dirUrl)}">Directions</button>
    </div>
  `;

  $("map-person-card-close")?.addEventListener("click", hideMapPersonCard);
  card.querySelector("[data-map-checkin]")?.addEventListener("click", () => {
    hideMapPersonCard();
    closeMapFullscreen();
    openBroadcastSheet(member.id);
  });
  card.querySelector("[data-map-directions]")?.addEventListener("click", () => {
    window.open(dirUrl, "_blank", "noopener,noreferrer");
  });
}

function getUserGeo() {
  const resolved = state.guidance?.resolved;
  if (typeof resolved?.lat === "number" && typeof resolved?.lng === "number") {
    return { lat: resolved.lat, lng: resolved.lng };
  }
  if (typeof state.selectedAddress?.lat === "number" && typeof state.selectedAddress?.lng === "number") {
    return { lat: state.selectedAddress.lat, lng: state.selectedAddress.lng };
  }
  return { lat: 20.8783, lng: -156.6797 };
}

function distanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getEligibleShelters(shelters) {
  if (!shelters?.length) return [];
  const d = state.data;
  const hasPets = d.animals && d.animals !== "none";
  const noCar = d.vehicle_access === "no";
  const mobility =
    (d.accessibility && d.accessibility !== "none") ||
    (d.vulnerable && d.vulnerable !== "none");

  const eligible = shelters.filter((s) => {
    if (hasPets && !s.pet_friendly) return false;
    if (mobility && !s.accessible) return false;
    if (noCar && !s.transit_accessible) return false;
    return true;
  });
  return eligible.length ? eligible : shelters;
}

function buildShelterDirections(shelter) {
  if (state.guidance?.how_to_get_there && state.routeSource === "guidance") {
    return state.guidance.how_to_get_there;
  }
  const d = state.data;
  if (d.vehicle_access === "no") {
    return shelter.transit_accessible
      ? `Use Maui County transit toward ${shelter.address}.`
      : `Coordinate pickup to ${shelter.address}.`;
  }
  return `Drive on designated evacuation routes to ${shelter.address}.`;
}

async function ensureSheltersLoaded() {
  if (state.shelters?.length) return state.shelters;
  try {
    const res = await fetch("/api/shelters");
    if (!res.ok) throw new Error("failed");
    const data = await res.json();
    state.shelters = Array.isArray(data) ? data : [];
  } catch {
    state.shelters = [
      {
        name: "War Memorial Gym",
        address: "Wailuku, HI",
        lat: 20.8893,
        lng: -156.5044,
        accessible: true,
        pet_friendly: false,
        transit_accessible: true,
      },
      {
        name: "Lahaina Civic Center",
        address: "Lahaina, HI",
        lat: 20.8783,
        lng: -156.6692,
        accessible: true,
        pet_friendly: true,
        transit_accessible: false,
      },
      {
        name: "Kihei Community Center",
        address: "Kihei, HI",
        lat: 20.7644,
        lng: -156.445,
        accessible: true,
        pet_friendly: false,
        transit_accessible: true,
      },
    ];
  }
  return state.shelters;
}

function findNearestShelter(shelters) {
  const geo = getUserGeo();
  const eligible = getEligibleShelters(shelters);
  let nearest = null;
  let minDist = Infinity;

  for (const shelter of eligible) {
    const dist = distanceKm(geo.lat, geo.lng, shelter.lat, shelter.lng);
    if (dist < minDist) {
      minDist = dist;
      nearest = shelter;
    }
  }

  if (!nearest) return null;
  return {
    shelter: nearest,
    lat: nearest.lat,
    lng: nearest.lng,
    label: nearest.name,
    distanceMi: (minDist * 0.621371).toFixed(1),
    directions: buildShelterDirections(nearest),
  };
}

function shelterFromGuidance() {
  const destName = (state.guidance?.destination || "").toLowerCase();
  if (!destName || !state.shelters?.length) return null;
  const shelter = state.shelters.find((s) => destName.includes(s.name.toLowerCase()));
  if (!shelter) return null;
  return {
    lat: shelter.lat,
    lng: shelter.lng,
    label: shelter.name,
    directions: buildShelterDirections(shelter),
  };
}

function getRouteDestination() {
  if (state.routeDestination) return state.routeDestination;
  const fromGuidance = shelterFromGuidance();
  if (fromGuidance) return fromGuidance;
  const geo = getUserGeo();
  const destName = state.guidance?.destination || "";
  return {
    lat: geo.lat + 0.02,
    lng: geo.lng + 0.02,
    label: destName || "Evacuation shelter",
    directions: state.guidance?.how_to_get_there || "Follow designated evacuation routes.",
  };
}

function updateMapNavButtons() {
  $("btn-nearest-shelter")?.classList.toggle(
    "is-active",
    state.showEvacuationRoute && state.routeSource === "nearest"
  );
}

function renderMapRoute() {
  syncMapRoute();
  updateMapNavButtons();
}

function showMapRouteLine() {
  state.mapRouteLineVisible = true;
  renderMapRoute();
  openMapFullscreen();
}

function scrollToEvacuationMap() {
  const scroll = () => {
    $("home-map-block")?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
  };
  if (prefersReducedMotion()) scroll();
  else setTimeout(scroll, 100);
}

async function showGuidanceRoute() {
  await ensureSheltersLoaded();
  state.routeSource = "guidance";
  state.routeDestination = shelterFromGuidance();
  state.showEvacuationRoute = true;
  state.mapRouteLineVisible = true;
  renderMapRoute();
}

async function openEvacuationRoute() {
  switchPlatformTab("home");
  await showGuidanceRoute();
  scrollToEvacuationMap();
  openMapFullscreen();
}

async function navigateToNearestShelter() {
  await ensureSheltersLoaded();
  const nearest = findNearestShelter(state.shelters);
  if (!nearest) return;

  state.routeSource = "nearest";
  state.routeDestination = {
    lat: nearest.lat,
    lng: nearest.lng,
    label: nearest.label,
    distanceMi: nearest.distanceMi,
    directions: nearest.directions,
  };
  state.showEvacuationRoute = true;
  state.mapRouteLineVisible = false;
  renderMapRoute();
  scrollToEvacuationMap();
}

function renderHomeGuidance(data) {
  const el = $("home-guidance");
  if (!el || !data) return;
  const failSafe = data.fail_safe === true;
  el.classList.toggle("is-failsafe", failSafe);
  const badge = failSafe
    ? "Advisory mode"
    : data.applies_to_user === false
      ? "Not in affected area"
      : "Your guidance";
  const action = data.recommended_action || "No active guidance at this time.";
  const summary = data.authoritative_summary || "";
  const zone = data.zone ?? "—";
  const resolved = data.resolved?.address || state.data.address || "—";
  el.innerHTML = `
    <span class="platform-guidance__badge">${escapeHtml(badge)}</span>
    <p class="platform-guidance__action">${escapeHtml(action)}</p>
    ${summary ? `<p class="platform-guidance__summary">${escapeHtml(summary)}</p>` : ""}
    <p class="platform-guidance__meta">${escapeHtml(resolved)} · Zone ${escapeHtml(zone || "Unknown")}${data.destination ? ` · Shelter: ${escapeHtml(data.destination)}` : ""}</p>
  `;
}

function renderMapPins() {
  if (!state.leaflet.preview) initMapPreview();
  else syncMapMarkers("preview");
  if (state.mapFullscreenOpen) syncMapMarkers("fullscreen");
}

function renderFamilyScroll() {
  const el = $("family-scroll");
  if (!el) return;
  el.innerHTML = buildFamilyMembers()
    .map(
      (m) => `
    <div class="member-card">
      <div class="member-card__avatar">
        ${escapeHtml(initials(m.name))}
        <span class="member-card__dot member-card__dot--${m.dot}"></span>
      </div>
      <span class="member-card__name">${escapeHtml(m.name.split(" ")[0])}</span>
      <span class="member-card__status">${escapeHtml(m.status)}</span>
    </div>`
    )
    .join("");
}

function renderHouseholdScroll() {
  renderFamilyScroll();
}

function renderFamilyView() {
  const sections = $("family-sections");
  const subtitle = $("family-subtitle");
  if (!sections) return;

  const dependents = buildFamilyMembers().filter((m) => m.id !== "user");
  const familyMembers = dependents.filter((m) => !m.invited);
  const invited = dependents.filter((m) => m.invited);

  if (subtitle) {
    subtitle.textContent = familyMembers.length
      ? `${familyMembers.length} family member${familyMembers.length === 1 ? "" : "s"}`
      : invited.length
        ? `${invited.length} invite${invited.length === 1 ? "" : "s"} pending`
        : "No other family members on your profile";
  }

  let html = "";

  const attention = familyMembers.filter((m) => m.dot === "warn");
  if (attention.length && needsAttention()) {
    html += `<section class="family-section"><h3 class="family-section__label family-section__label--attention"><span class="family-section__dot"></span>Attention required</h3>`;
    attention.forEach((m) => {
      html += familyCardHtml(m, "attention");
    });
    html += `</section>`;
  }

  const others = familyMembers.filter((m) => m.dot !== "warn" || !needsAttention());
  const safeMembers = others.filter((m) => m.status === "Safe" || m.dot === "safe");
  const remainingOthers = others.filter((m) => m.status !== "Safe" && m.dot !== "safe");

  if (safeMembers.length) {
    html += `<section class="family-section"><h3 class="family-section__label family-section__label--safe"><span class="family-section__dot"></span>Safe</h3>`;
    safeMembers.forEach((m) => {
      html += familyCardHtml(m, "safe");
    });
    html += `</section>`;
  }

  if (remainingOthers.length) {
    const label = remainingOthers.some((m) => m.dot === "warn") ? "Attention required" : "Family";
    const labelClass = remainingOthers.some((m) => m.dot === "warn") ? "attention" : "transit";
    html += `<section class="family-section"><h3 class="family-section__label family-section__label--${labelClass}"><span class="family-section__dot"></span>${label}</h3>`;
    remainingOthers.forEach((m) => {
      html += familyCardHtml(m, m.dot === "warn" ? "attention" : "transit");
    });
    html += `</section>`;
  }

  if (invited.length) {
    html += `<section class="family-section"><h3 class="family-section__label family-section__label--transit"><span class="family-section__dot"></span>Invited</h3>`;
    invited.forEach((m) => {
      html += familyCardHtml({ ...m, cardDetail: `${m.detail} · ${m.phone || "Invite sent"}` }, "transit", true);
    });
    html += `</section>`;
  }

  if (!html) {
    html = `<p class="platform-page__subtitle">Add dependents during onboarding or invite family from Home.</p>`;
  }

  sections.innerHTML = html;
}

function familyCardDetail(member, variant) {
  if (member.cardDetail) return member.cardDetail;
  if (variant === "safe") return member.location;
  return `${member.status} · ${member.location}`;
}

function familyCardHtml(member, variant, showActions = true) {
  const name = member.name;
  const detail = familyCardDetail(member, variant);
  return `
    <div class="family-card${variant === "attention" ? " family-card--attention" : ""}" data-member-id="${escapeHtml(member.id)}">
      <div class="family-card__row">
        <div class="family-card__avatar">${escapeHtml(initials(name))}</div>
        <div class="family-card__info">
          <p class="family-card__name">${escapeHtml(name)}</p>
          <p class="family-card__detail">${escapeHtml(detail)}</p>
        </div>
      </div>
      ${
        showActions
          ? `<div class="family-card__actions">
        <button type="button" class="family-card__action" data-checkin-id="${escapeHtml(member.id)}"><span class="family-card__action-icon">📡</span>Check-in</button>
        <button type="button" class="family-card__action" data-stub="call"><span class="family-card__action-icon">📞</span>Call</button>
        <button type="button" class="family-card__action" data-stub="route"><span class="family-card__action-icon">📍</span>Route</button>
      </div>`
          : ""
      }
    </div>`;
}

function shortAddress(addr) {
  if (!addr) return "Address on file";
  const parts = addr.split(",");
  return parts.slice(0, 2).join(",").trim() || addr;
}

function buildUpdatesHtml(alerts, filter, limit = null) {
  let filtered =
    filter === "all" ? [...alerts] : alerts.filter((a) => categorizeUpdate(a) === filter);
  if (limit) {
    filtered = sortUpdatesByPriority(filtered).slice(0, limit);
  }

  if (!filtered.length) {
    return `<p class="platform-page__subtitle">No updates in this category.</p>`;
  }

  return filtered
    .map(
      (a) => `
    <article class="update-card">
      <div class="update-card__head">
        ${renderUpdateSourceHead(a)}
        <span class="update-card__time">${updateTimeLabel(a, alerts)}</span>
      </div>
      <span class="update-card__badge">${escapeHtml(a.event)}</span>
      <p class="update-card__text">${escapeHtml(a.text)}</p>
      ${renderUpdatePersonalStatus(a)}
      <p class="update-card__area">${escapeHtml(a.area)} · ${escapeHtml(a.severity)}</p>
      ${renderUpdateReadMore(a)}
    </article>`
    )
    .join("");
}

function renderUpdatesFeed(alerts, targetId = "updates-feed", filter = state.updateFilter) {
  const el = $(targetId);
  if (!el) return;
  el.innerHTML = buildUpdatesHtml(alerts, filter);
}

function renderHomeUpdatesPreview(alerts) {
  const el = $("home-updates-feed");
  if (!el) return;
  el.innerHTML = buildUpdatesHtml(alerts, state.homeUpdateFilter, 2);
}

function buildRightNowPrepItems() {
  const d = state.data;
  const items = [
    { id: "now-evac", label: "Follow your evacuation guidance", detail: "Check the instruction card below", urgent: true },
    { id: "now-go-bag", label: "Grab your go-bag", detail: "Water, meds, documents, chargers", urgent: true },
  ];

  if (d.vehicle_access === "no") {
    items.push({ id: "now-transit", label: "Confirm transit or pickup plan", detail: "No vehicle — use county transit or meet at pickup point", urgent: true });
  } else {
    items.push({ id: "now-vehicle", label: "Stage your vehicle", detail: "Keys, fuel, and an open evacuation route", urgent: true });
  }

  if (d.evacuating === "small" || d.evacuating === "large") {
    items.push({ id: "now-pickup", label: "Coordinate dependent pickup", detail: DISPLAY.evacuating[d.evacuating], urgent: true });
  }

  if (d.animals && d.animals !== "none") {
    items.push({ id: "now-pets", label: "Secure pets for evacuation", detail: DISPLAY.animals[d.animals], urgent: true });
  }

  if (d.vulnerable && d.vulnerable !== "none") {
    items.push({ id: "now-vulnerable", label: "Assist vulnerable family members", detail: DISPLAY.vulnerable[d.vulnerable], urgent: true });
  }

  if (d.accessibility && d.accessibility !== "none") {
    const acc =
      d.accessibility === "other"
        ? d.accessibility_other || "Other needs"
        : DISPLAY.accessibility[d.accessibility];
    items.push({ id: "now-access", label: "Confirm accessibility plan", detail: acc, urgent: true });
  }

  items.push({ id: "now-checkin", label: "Send a family check-in", detail: "Check in with one person or your whole family from Home", urgent: false });
  return items;
}

function buildLongtermPrepItems() {
  return [
    { id: "lt-gobag", label: "Pack a go-bag", detail: "Keep it ready by the door" },
    { id: "lt-meeting", label: "Agree on a meeting point", detail: "Outside your zone, easy for everyone to reach" },
    { id: "lt-contacts", label: "Save emergency contacts", detail: "Include out-of-area contacts" },
    { id: "lt-drill", label: "Practice your evacuation drill", detail: "Walk through routes with your family once a year" },
    { id: "lt-alerts", label: "Sign up for county alerts", detail: "Maui County emergency notifications" },
  ];
}

function renderPrepListSection(listId, items, sectionPrefix) {
  const el = $(listId);
  if (!el) return;
  el.innerHTML = items
    .map((item) => {
      const checked = state.prepChecked[item.id] ? "checked" : "";
      return `
    <li class="prep-item${item.urgent ? " prep-item--urgent" : ""}">
      <input type="checkbox" class="prep-item__check" data-prep-id="${item.id}" ${checked} aria-label="${escapeHtml(item.label)}">
      <div class="prep-item__text">${escapeHtml(item.label)}<small>${escapeHtml(item.detail || "")}</small></div>
    </li>`;
    })
    .join("");

  el.querySelectorAll(".prep-item__check").forEach((cb) => {
    cb.addEventListener("change", () => {
      state.prepChecked[cb.dataset.prepId] = cb.checked;
    });
  });
}

function renderPrepList() {
  renderPrepListSection("prep-now-list", buildRightNowPrepItems(), "now");
  renderPrepListSection("prep-longterm-list", buildLongtermPrepItems(), "lt");
}

function renderProfileSheet() {
  const list = $("profile-list");
  if (!list) return;
  openEditorKey = null;
  openEditorListId = null;
  reviewAddressSelection = null;
  list.innerHTML = PROFILE_KEYS.map(({ key, label, readonly }, i) => {
    const value = displayValue(key);
    const editBtn = readonly
      ? ""
      : `<button type="button" class="review-item__edit" data-profile-edit="${key}" aria-label="Edit ${escapeHtml(label)}">Edit</button>`;
    const rowClass = readonly ? " review-item--readonly" : "";
    return `<li class="review-item${rowClass}" data-review-key="${key}" style="--i: ${i}">
      <div class="review-item__main">
        <div class="review-item__label review-item__label--static">
          <span class="review-item__content">
            <span class="review-item__title">${escapeHtml(label)}</span>
            <span class="review-item__value">${escapeHtml(value)}</span>
          </span>
        </div>
        ${editBtn}
      </div>
      <div class="review-item__editor" hidden></div>
    </li>`;
  }).join("");
}

function openOverlay(id) {
  const el = $(id);
  if (!el) return;
  el.removeAttribute("hidden");
  el.classList.remove("is-open");
  void el.offsetHeight;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add("is-open"));
  });
}

function closeOverlay(id) {
  const el = $(id);
  if (!el) return;
  el.classList.remove("is-open");
  const delay = prefersReducedMotion() ? 0 : 220;
  setTimeout(() => {
    el.setAttribute("hidden", "");
  }, delay);
}

function openProfileSheet() {
  renderProfileSheet();
  openOverlay("profile-overlay");
}

function openInviteSheet() {
  const hint = $("invite-hint");
  if (hint) {
    hint.textContent = "";
    hint.classList.remove("is-error");
  }
  $("invite-name").value = "";
  $("invite-phone").value = "";
  openOverlay("invite-overlay");
}

function getCheckinTargets() {
  return buildFamilyMembers().filter((m) => !m.isYou);
}

function updateCheckinSendButton() {
  const btn = $("btn-send-checkin");
  if (!btn) return;
  const any = document.querySelector(".checkin-picker__check:checked");
  btn.disabled = !any;
}

function renderBroadcastMemberPicker(selectedIds) {
  const members = getCheckinTargets();
  const picker = $("broadcast-member-picker");
  const btn = $("btn-send-checkin");
  if (!picker) return;

  if (!members.length) {
    picker.innerHTML =
      '<p class="checkin-picker__empty">No family members to check in with yet. Add dependents or invite someone from Home.</p>';
    if (btn) btn.disabled = true;
    return;
  }

  const selected = new Set(selectedIds ?? members.map((m) => m.id));

  picker.innerHTML = `
    <div class="checkin-picker__toolbar">
      <span class="checkin-picker__label-text">Send to</span>
      <button type="button" class="home-section__link" id="btn-checkin-select-all">Everyone</button>
      <button type="button" class="home-section__link" id="btn-checkin-select-none">Clear</button>
    </div>
    <ul class="checkin-picker" role="list">
      ${members
        .map(
          (m) => `<li class="checkin-picker__item">
        <label class="checkin-picker__row">
          <input type="checkbox" class="checkin-picker__check" data-checkin-target="${escapeHtml(m.id)}"${selected.has(m.id) ? " checked" : ""}>
          <span class="checkin-picker__avatar">${escapeHtml(initials(m.name))}</span>
          <span class="checkin-picker__info">
            <span class="checkin-picker__name">${escapeHtml(m.name)}</span>
            <span class="checkin-picker__meta">${escapeHtml(m.status)}${m.phone ? ` · ${escapeHtml(m.phone)}` : m.location ? ` · ${escapeHtml(shortAddress(m.location))}` : ""}</span>
          </span>
        </label>
      </li>`
        )
        .join("")}
    </ul>`;

  picker.querySelectorAll(".checkin-picker__check").forEach((cb) => {
    cb.addEventListener("change", updateCheckinSendButton);
  });

  $("btn-checkin-select-all")?.addEventListener("click", () => {
    picker.querySelectorAll(".checkin-picker__check").forEach((cb) => {
      cb.checked = true;
    });
    updateCheckinSendButton();
  });

  $("btn-checkin-select-none")?.addEventListener("click", () => {
    picker.querySelectorAll(".checkin-picker__check").forEach((cb) => {
      cb.checked = false;
    });
    updateCheckinSendButton();
  });

  updateCheckinSendButton();
}

function openBroadcastSheet(memberId = null) {
  const subtitle = $("broadcast-sheet-subtitle");
  const title = $("broadcast-sheet-title");
  const members = getCheckinTargets();

  if (title) {
    title.textContent = memberId ? "Check in" : "Family check-in";
  }
  if (subtitle) {
    subtitle.textContent = memberId
      ? `Send a safety check to ${members.find((m) => m.id === memberId)?.name?.split(" ")[0] || "this family member"}.`
      : "Choose who to check in with — you don't have to ping everyone.";
  }

  const selected = memberId ? [memberId] : members.map((m) => m.id);
  renderBroadcastMemberPicker(selected);

  const messageEl = $("broadcast-message");
  if (messageEl) {
    messageEl.value = state.checkinMessage || DEFAULT_CHECKIN_MESSAGE;
  }

  const hint = $("broadcast-hint");
  if (hint) {
    hint.textContent = "";
    hint.classList.remove("is-error");
  }
  openOverlay("broadcast-overlay");
}

function sendCheckin() {
  const checked = [...document.querySelectorAll(".checkin-picker__check:checked")];
  const hint = $("broadcast-hint");
  const messageEl = $("broadcast-message");
  const message = messageEl?.value?.trim() || "";

  if (!message) {
    if (hint) {
      hint.textContent = "Enter a message for your check-in.";
      hint.classList.add("is-error");
    }
    messageEl?.focus();
    return;
  }

  if (!checked.length) {
    if (hint) {
      hint.textContent = "Select at least one family member.";
      hint.classList.add("is-error");
    }
    return;
  }

  state.checkinMessage = message;

  const names = checked
    .map((cb) => getCheckinTargets().find((m) => m.id === cb.dataset.checkinTarget)?.name.split(" ")[0])
    .filter(Boolean);

  if (hint) {
    hint.textContent =
      names.length === 1
        ? `Check-in sent to ${names[0]} (demo).`
        : `Check-in sent to ${names.join(", ")} (demo).`;
    hint.classList.remove("is-error");
  }
  setTimeout(() => closeOverlay("broadcast-overlay"), 1200);
}

async function loadUpdates() {
  let alerts = state.cachedAlerts;
  try {
    const res = await fetch("/api/updates");
    if (!res.ok) throw new Error("failed");
    const data = await res.json();
    alerts = Array.isArray(data) ? data : [];
  } catch {
    alerts = [
      {
        source: "County civil defense",
        event: "Flash Flood Warning",
        area: "West Maui, Lahaina",
        severity: "Severe",
        url: "https://www.mauicounty.gov/983/MEMA-Alerts",
        text: "Evacuate low-lying areas immediately. Proceed to higher ground.",
      },
      {
        source: "National Weather Service",
        event: "Road Advisory",
        area: "Lahaina",
        severity: "Moderate",
        url: "https://www.weather.gov/hfo/",
        text: "Avoid Honoapiilani Highway, flooding reported.",
      },
      {
        source: "Maui Fire Department",
        event: "Shelter Open",
        area: "Central Maui",
        severity: "Info",
        url: "https://www.mauifire.gov/",
        text: "War Memorial Gym accepting evacuees. Bring ID and medications.",
      },
    ];
  }
  state.cachedAlerts = alerts;
  renderUpdatesFeed(alerts, "updates-feed", state.updateFilter);
  renderHomeUpdatesPreview(alerts);
}

function renderPlatform() {
  const d = state.data;
  const greeting = $("platform-greeting");
  const avatar = $("platform-avatar");

  if (greeting) greeting.textContent = `Hi, ${firstName(d.first_name || d.name)}`;
  if (avatar) avatar.textContent = initials(fullName(d));

  renderMapPins();
  renderMapRoute();
  renderFamilyScroll();
  renderHomeGuidance(state.guidance);
  renderFamilyView();
  renderPrepList();
  ensureSheltersLoaded();
  loadUpdates();
}

function switchPlatformTab(tab) {
  state.platformTab = tab;
  document.querySelectorAll(".platform-nav__item").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.platformTab === tab);
  });
  document.querySelectorAll(".platform-view").forEach((view) => {
    const active = view.dataset.platformView === tab;
    view.classList.toggle("is-active", active);
    view.hidden = !active;
  });
}

function skipOnboardingDev() {
  state.step = 10;
  state.selectedAddress = {
    address: "671 Front St, Lahaina, HI 96761",
    lat: 20.8783,
    lng: -156.6797,
  };
  state.data = {
    first_name: "Alex",
    last_name: "Rivera",
    name: "Alex Rivera",
    phone: "+1 (808) 555-0142",
    birth_date: "1990-06-15",
    age: 35,
    address: state.selectedAddress.address,
    vehicle_access: "yes",
    vehicle_count: "1",
    evacuating: "small",
    vulnerable: "none",
    accessibility: "none",
    animals: "pets",
  };

  enterPlatform({
    resolved: {
      address: state.data.address,
      lat: state.selectedAddress.lat,
      lng: state.selectedAddress.lng,
    },
    zone: "Lahaina-1",
    authoritative_summary: "Flash Flood Warning — follow official county guidance.",
    applies_to_user: true,
    recommended_action: "Evacuate now via official routes. Take your family and go-bag.",
    destination: "Lahaina Civic Center",
    how_to_get_there: "Drive on designated evacuation routes. Do not use unmarked shortcuts.",
    confidence: 0.75,
    fail_safe: false,
    reasoning: "Dev skip — demo guidance.",
  });
}

function shouldAutoSkipOnboarding() {
  const params = new URLSearchParams(window.location.search);
  return params.has("skip") || params.get("dev") === "1";
}

async function enterPlatform(guidance) {
  state.guidance = guidance;

  document.querySelectorAll(".step").forEach((s) => {
    s.classList.remove("is-active", "is-leaving", "is-entering", "is-animating");
  });

  const app = $("app");
  const platform = $("platform");
  if (app) app.classList.add("platform-mode");
  if (platform) {
    platform.hidden = false;
    switchPlatformTab("home");
    if (prefersReducedMotion()) {
      platform.classList.add("is-active");
    } else {
      platform.classList.remove("is-active");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => platform.classList.add("is-active"));
      });
    }
    try {
      renderPlatform();
      startDemoStatePolling();
    } catch (err) {
      console.error("Platform render failed", err);
    }
  }
}

function exitPlatform() {
  closeMapFullscreen();
  destroyLeafletMap("preview");
  const app = $("app");
  const platform = $("platform");
  if (app) app.classList.remove("platform-mode");
  if (platform) {
    platform.classList.remove("is-active");
    platform.hidden = true;
  }
  stopDemoStatePolling();
  state.guidance = null;
  state.platformTab = "home";
}

// ---- Live scenario sync ----------------------------------------------------
// While on the platform, poll the MCP bridge's /demo-state. When the Poke-driven
// scenario is active, mirror it in the app: news feed, "Right now" tasks, and guidance.
// Map pins stay static in this demo.
let demoStateTimer = null;

function updateLiveMapPin() {
  // Static pins only — demo GPS movement is not shown on the home map.
}

// Calm "all clear" state — shown whenever no disaster/scenario is active. The app's
// disaster display is driven entirely by the bridge, so the baseline is honest.
function renderAllClear() {
  state.showEvacuationRoute = false;
  renderMapRoute();
  $("map-pins")?.querySelector(".map-pin--live")?.remove();

  const g = $("home-guidance");
  if (g) {
    g.classList.remove("is-failsafe");
    g.innerHTML = `
      <span class="platform-guidance__badge">All clear</span>
      <p class="platform-guidance__action">No active evacuation orders for your area.</p>
      <p class="platform-guidance__summary">We're monitoring official channels and will alert you the moment anything changes.</p>
      <p class="platform-guidance__meta">${escapeHtml(state.data.address || "Your area")} · Monitoring</p>`;
  }
  const calm = `<div style="padding:18px;border-radius:16px;background:rgba(20,20,20,.04);color:#6b6b6b;font-size:14px;line-height:1.5">No active alerts. We're monitoring official channels for your region and will notify you if an emergency is declared.</div>`;
  const uf = $("updates-feed"); if (uf) uf.innerHTML = calm;
  const huf = $("home-updates-feed"); if (huf) huf.innerHTML = calm;
  renderPrepListSection("prep-now-list", [
    { id: "clear-ready", label: "You're all set — no action needed right now", detail: "We'll send your steps here if an emergency is declared", urgent: false },
  ], "now");
}

function applyDemoState(d) {
  if (!d || !d.active) { renderAllClear(); return; }

  // Disaster active — drive the whole app from the scenario.
  if (d.guidance && d.guidance.recommended_action) {
    state.guidance = { ...d.guidance, resolved: { address: state.data.address } };
    renderHomeGuidance(state.guidance);
    if (d.guidance.destination) {
      state.routeDestination = null;
      state.routeSource = "guidance";
      state.showEvacuationRoute = true;
      renderMapRoute();
    }
  }
  if (Array.isArray(d.news) && d.news.length) {
    state.cachedAlerts = d.news;
    renderUpdatesFeed(d.news, "updates-feed", state.updateFilter);
    renderHomeUpdatesPreview(d.news);
  }
  if (Array.isArray(d.tasks) && d.tasks.length) {
    const items = d.tasks.map((t, i) => ({ id: `live-${i}`, label: t, detail: "", urgent: true }));
    renderPrepListSection("prep-now-list", items, "now");
  }
  if (d.position) updateLiveMapPin();
}

async function pollDemoStateOnce() {
  try {
    const res = await fetch(`${MCP_BASE}/demo-state`, { cache: "no-store" });
    if (!res.ok) return;
    applyDemoState(await res.json());
  } catch { /* MCP bridge not running — ignore */ }
}

function startDemoStatePolling() {
  if (demoStateTimer) return;
  pollDemoStateOnce();
  demoStateTimer = setInterval(pollDemoStateOnce, 3000);
}

function stopDemoStatePolling() {
  if (demoStateTimer) { clearInterval(demoStateTimer); demoStateTimer = null; }
}

function setActivateHint(msg, isError = false) {
  const el = $("activate-hint");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("is-error", isError);
}

async function fetchGuidance() {
  const btn = $("btn-activate");
  if (!btn || btn.disabled) return;

  setActivateHint("");
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

  // Bridge: tell the Poke/MCP server who this household is, so the scenario Poke
  // plays is personalized to the onboarding answers. Fire-and-forget — never blocks
  // or fails activation (the MCP server may not be running in a web-only setup).
  fetch(`${MCP_BASE}/profile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});

  const resetBtn = () => {
    btn.classList.remove("btn--loading");
    btn.textContent = "Activate Profile";
    updateActivateButton();
  };

  try {
    const res = await fetch("/api/advise", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    let data;
    try {
      data = await res.json();
    } catch {
      setActivateHint("Server returned an unexpected response. Restart the dev server and try again.", true);
      resetBtn();
      return;
    }

    if (!res.ok) {
      setActivateHint(data.error || "Something went wrong. Please try again.", true);
      resetBtn();
      return;
    }

    resetBtn();
    await enterPlatform(data);
  } catch {
    setActivateHint("Request failed. Check your connection and that the server is running.", true);
    resetBtn();
  }
}

function resetForm() {
  isTransitioning = false;
  exitPlatform();
  state.selectedAddress = null;
  state.data = {};
  state.step = 0;
  state.invitedMembers = [];
  state.prepChecked = {};
  state.cachedAlerts = [];

  $("first-name").value = "";
  $("last-name").value = "";
  $("phone").value = "";
  document.querySelectorAll('input[type="radio"]').forEach((r) => (r.checked = false));

  const otherField = $("accessibility-other-field");
  const otherInput = $("accessibility-other");
  if (otherInput) otherInput.value = "";
  if (otherField) otherField.classList.remove("is-open");

  const reviewList = $("review-list");
  if (reviewList) reviewList.classList.remove("is-visible");
  openEditorKey = null;
  openEditorListId = null;
  reviewAddressSelection = null;

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
  setActivateHint("");
  resetDobPicker();
  document.querySelectorAll(".step").forEach((s) => {
    s.classList.remove("is-active", "is-leaving", "is-entering", "is-animating");
  });
  $("step-welcome").classList.add("is-active");
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

function bindPlatform() {
  document.querySelectorAll(".platform-nav__item").forEach((btn) => {
    btn.addEventListener("click", () => switchPlatformTab(btn.dataset.platformTab));
  });

  $("platform-avatar")?.addEventListener("click", openProfileSheet);
  $("btn-close-profile")?.addEventListener("click", () => closeOverlay("profile-overlay"));
  $("profile-overlay")?.addEventListener("click", (e) => {
    if (e.target.id === "profile-overlay") closeOverlay("profile-overlay");
  });

  $("btn-invite-family")?.addEventListener("click", openInviteSheet);
  $("btn-invite-family-tab")?.addEventListener("click", openInviteSheet);
  $("btn-close-invite")?.addEventListener("click", () => closeOverlay("invite-overlay"));
  $("invite-overlay")?.addEventListener("click", (e) => {
    if (e.target.id === "invite-overlay") closeOverlay("invite-overlay");
  });

  $("invite-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("invite-name").value.trim();
    const phone = $("invite-phone").value.trim();
    const hint = $("invite-hint");
    if (!name) {
      $("invite-name").focus();
      return;
    }
    if (!isPhoneComplete(phone)) {
      hint.textContent = "Enter a complete 10-digit US mobile number.";
      hint.classList.add("is-error");
      return;
    }
    state.invitedMembers.push({ name, phone: formatPhoneDisplay(phone) });
    closeOverlay("invite-overlay");
    refreshPlatformAfterProfileEdit();
  });

  $("btn-broadcast")?.addEventListener("click", () => openBroadcastSheet());
  $("btn-close-broadcast")?.addEventListener("click", () => closeOverlay("broadcast-overlay"));
  $("broadcast-overlay")?.addEventListener("click", (e) => {
    if (e.target.id === "broadcast-overlay") closeOverlay("broadcast-overlay");
  });
  $("btn-send-checkin")?.addEventListener("click", sendCheckin);

  $("btn-see-all-updates")?.addEventListener("click", () => switchPlatformTab("updates"));

  $("btn-nearest-shelter")?.addEventListener("click", () => {
    navigateToNearestShelter();
  });

  $("home-map")?.addEventListener("click", () => openMapFullscreen());
  $("btn-map-close")?.addEventListener("click", () => closeMapFullscreen());
  $("btn-map-zoom-in")?.addEventListener("click", () => state.leaflet.fullscreen?.zoomIn());
  $("btn-map-zoom-out")?.addEventListener("click", () => state.leaflet.fullscreen?.zoomOut());
  $("map-fullscreen-container")?.addEventListener("click", () => hideMapPersonCard());
  $("map-person-card")?.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.mapFullscreenOpen) closeMapFullscreen();
  });

  document.querySelectorAll("#update-pills .platform-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      state.updateFilter = pill.dataset.filter;
      document.querySelectorAll("#update-pills .platform-pill").forEach((p) => {
        p.classList.toggle("is-active", p === pill);
      });
      renderUpdatesFeed(state.cachedAlerts, "updates-feed", state.updateFilter);
    });
  });

  document.querySelectorAll("#home-update-pills .platform-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      state.homeUpdateFilter = pill.dataset.filter;
      document.querySelectorAll("#home-update-pills .platform-pill").forEach((p) => {
        p.classList.toggle("is-active", p === pill);
      });
      renderHomeUpdatesPreview(state.cachedAlerts);
    });
  });

  document.querySelector(".platform-main")?.addEventListener("click", (e) => {
    const routeBtn = e.target.closest("[data-view-route]");
    if (routeBtn) {
      e.preventDefault();
      openEvacuationRoute();
    }
  });

  $("family-sections")?.addEventListener("click", (e) => {
    const checkinBtn = e.target.closest("[data-checkin-id]");
    if (checkinBtn) {
      e.preventDefault();
      openBroadcastSheet(checkinBtn.dataset.checkinId);
      return;
    }
    const btn = e.target.closest("[data-stub]");
    if (!btn) return;
    alert(`${btn.dataset.stub.charAt(0).toUpperCase() + btn.dataset.stub.slice(1)} is not available in this demo.`);
  });
}

function bindEvents() {
  $("btn-welcome").addEventListener("click", () => goToStep(1));
  $("btn-skip-dev")?.addEventListener("click", skipOnboardingDev);
  $("btn-contact-next").addEventListener("click", goNext);
  $("btn-q1-next").addEventListener("click", goNext);
  $("btn-q7-next").addEventListener("click", goNext);
  $("btn-activate").addEventListener("click", fetchGuidance);

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
  bindPlatform();
  bindPhoneInput();
  bindDobPicker();
  bindAccessibilityOther();
  bindReviewList();
  bindProfileList();
  if (shouldAutoSkipOnboarding()) skipOnboardingDev();
});
