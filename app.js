(function () {
  "use strict";

  var ALLERGENS = ["Milk", "Egg", "Shellfish", "Fish", "Tree Nuts", "Wheat", "Peanuts", "Sesame", "Soybeans", "Gluten", "Pork", "Alcohol"];
  var DIET = ["Vegan Option", "Vegetarian Option", "Halal", "Kosher"];
  var BADGE_ABBR = {
    "Milk": "Milk", "Egg": "Egg", "Shellfish": "Shell", "Fish": "Fish", "Tree Nuts": "TreeNut",
    "Wheat": "Wheat", "Peanuts": "PNut", "Sesame": "Sesame", "Soybeans": "Soy",
    "Gluten": "Gluten", "Pork": "Pork", "Alcohol": "Alc",
    "Vegan Option": "Vegan", "Vegetarian Option": "Veg", "Halal": "Halal", "Kosher": "Kosher"
  };
  var CO2_CLASS = { "Low Carbon Footprint": "low", "Medium Carbon Footprint": "med", "High Carbon Footprint": "high" };

  var state = {
    data: null,
    date: null,
    search: "",
    searchAllDays: false,
    include: new Set(),
    exclude: new Set(),
    activeMeal: {} // locationSlug -> meal index
  };

  var els = {
    dateTabs: document.getElementById("date-tabs"),
    filterRowInclude: document.getElementById("filter-row-include"),
    filterRowExclude: document.getElementById("filter-row-exclude"),
    locations: document.getElementById("locations"),
    emptyState: document.getElementById("empty-state"),
    search: document.getElementById("search"),
    searchAllDays: document.getElementById("search-all-days"),
    updatedAt: document.getElementById("updated-at"),
    themeToggle: document.getElementById("theme-toggle"),
    themeIcon: document.getElementById("theme-icon"),
    scrollTop: document.getElementById("scroll-top")
  };

  function loadPrefs() {
    try {
      var raw = localStorage.getItem("bdm-prefs");
      if (!raw) return;
      var p = JSON.parse(raw);
      if (p.include) state.include = new Set(p.include);
      if (p.exclude) state.exclude = new Set(p.exclude);
      if (typeof p.searchAllDays === "boolean") state.searchAllDays = p.searchAllDays;
    } catch (e) { /* ignore */ }
  }

  function savePrefs() {
    try {
      localStorage.setItem("bdm-prefs", JSON.stringify({
        include: Array.from(state.include),
        exclude: Array.from(state.exclude),
        searchAllDays: state.searchAllDays
      }));
    } catch (e) { /* ignore */ }
  }

  els.searchAllDays.addEventListener("change", function () {
    state.searchAllDays = els.searchAllDays.checked;
    savePrefs();
    renderLocations();
  });

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem("bdm-theme"); } catch (e) {}
    if (saved) {
      document.documentElement.setAttribute("data-theme", saved);
    }
    updateThemeIcon();
  }

  function updateThemeIcon() {
    var explicit = document.documentElement.getAttribute("data-theme");
    var dark = explicit ? explicit === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    els.themeIcon.textContent = dark ? "☀️" : "🌙";
  }

  els.themeToggle.addEventListener("click", function () {
    var current = document.documentElement.getAttribute("data-theme");
    var systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var currentlyDark = current ? current === "dark" : systemDark;
    var next = currentlyDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("bdm-theme", next); } catch (e) {}
    updateThemeIcon();
  });

  window.addEventListener("scroll", function () {
    els.scrollTop.hidden = window.scrollY < 400;
  });
  els.scrollTop.addEventListener("click", function () {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  function fmtUpdated(iso) {
    try {
      var d = new Date(iso);
      return "Updated " + d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (e) {
      return "";
    }
  }

  // All date math is done in Berkeley time, regardless of the viewer's zone.
  var TZ = "America/Los_Angeles";

  function pacificNow() {
    var parts = {};
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
    return {
      date: parts.year + parts.month + parts.day,
      minutes: parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10)
    };
  }

  function dayDiff(a, b) {
    function toUTC(s) { return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)); }
    return Math.round((toUTC(a) - toUTC(b)) / 86400000);
  }

  // The labels baked into menus.json are relative to when it was generated,
  // so recompute them against the current date.
  function relabelDates(data) {
    var today = pacificNow().date;
    data.dates.forEach(function (d) {
      var delta = dayDiff(d.date, today);
      d.label = delta === -1 ? "Yesterday" : delta === 0 ? "Today" : delta === 1 ? "Tomorrow" : d.display;
    });
    var current = data.dates.filter(function (d) { return dayDiff(d.date, today) >= -1; });
    if (current.length) data.dates = current;
    return today;
  }

  function parseClock(s) {
    var m = /(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/i.exec(s);
    if (!m) return null;
    var h = parseInt(m[1], 10) % 12;
    if (m[3].toLowerCase() === "p") h += 12;
    return h * 60 + parseInt(m[2], 10);
  }

  // Open/closed from the posted hours, since the scraped status is a snapshot.
  function liveStatus(loc, dateStr) {
    if (!loc.hours.length) return "Closed";
    var now = pacificNow();
    if (dateStr !== now.date) return "";
    var open = loc.hours.some(function (h) {
      var range = h.split(/\s+-\s+/);
      var start = parseClock(range[0] || ""), end = parseClock(range[1] || "");
      if (start === null || end === null) return false;
      return end > start ? now.minutes >= start && now.minutes < end
                         : now.minutes >= start || now.minutes < end;
    });
    return open ? "Now Open" : "Now Closed";
  }

  function renderDateTabs() {
    els.dateTabs.innerHTML = "";
    state.data.dates.forEach(function (d) {
      var btn = document.createElement("button");
      btn.className = "date-tab" + (d.date === state.date ? " active" : "");
      btn.type = "button";
      btn.textContent = d.label === "Today" || d.label === "Yesterday" || d.label === "Tomorrow" ? d.label : d.display;
      btn.addEventListener("click", function () {
        state.date = d.date;
        render();
      });
      els.dateTabs.appendChild(btn);
    });
  }

  function makeChip(label, group) {
    var chip = document.createElement("button");
    chip.type = "button";
    var set = group === "include" ? state.include : state.exclude;
    var active = set.has(label);
    chip.className = "chip " + group + (active ? " active" : "");
    chip.title = group === "include" ? "Show only dishes with " + label : "Hide dishes with " + label;

    if (active) {
      var mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent = group === "include" ? "✓" : "✕";
      chip.appendChild(mark);
    }
    chip.appendChild(document.createTextNode(label.replace(" Option", "")));

    chip.addEventListener("click", function () {
      if (active) set.delete(label); else set.add(label);
      savePrefs();
      renderFilterRow();
      renderLocations();
    });
    return chip;
  }

  function renderFilterRow() {
    els.filterRowInclude.innerHTML = "";
    els.filterRowExclude.innerHTML = "";
    DIET.forEach(function (label) { els.filterRowInclude.appendChild(makeChip(label, "include")); });
    ALLERGENS.forEach(function (label) { els.filterRowExclude.appendChild(makeChip(label, "exclude")); });
  }

  function itemVisible(item) {
    var q = state.search.trim().toLowerCase();
    if (q) {
      var hay = (item.name + " " + item.icons.join(" ")).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    if (state.include.size > 0) {
      var hasInclude = item.icons.some(function (i) { return state.include.has(i); });
      if (!hasInclude) return false;
    }
    if (state.exclude.size > 0) {
      var hasExclude = item.icons.some(function (i) { return state.exclude.has(i); });
      if (hasExclude) return false;
    }
    return true;
  }

  function badgeFor(label) {
    if (CO2_CLASS[label]) {
      var dot = document.createElement("span");
      dot.className = "badge badge-co2 " + CO2_CLASS[label];
      dot.title = label;
      return dot;
    }
    var b = document.createElement("span");
    var isDiet = DIET.indexOf(label) !== -1;
    b.className = "badge " + (isDiet ? "badge-diet" : "badge-allergen");
    b.title = label;
    b.textContent = BADGE_ABBR[label] || label;
    return b;
  }

  function buildMealBody(meal) {
    var wrap = document.createElement("div");
    wrap.className = "meal-body";
    var anyVisible = false;

    meal.categories.forEach(function (cat) {
      var visibleItems = cat.items.filter(itemVisible);
      if (visibleItems.length === 0) return;
      anyVisible = true;

      var catEl = document.createElement("div");
      catEl.className = "category";
      var h = document.createElement("p");
      h.className = "category-name";
      h.textContent = cat.name;
      catEl.appendChild(h);

      visibleItems.forEach(function (item) {
        var row = document.createElement("div");
        row.className = "item-row";
        var name = document.createElement("span");
        name.className = "item-name";
        name.textContent = item.name;
        row.appendChild(name);

        var badges = document.createElement("span");
        badges.className = "badges";
        item.icons.forEach(function (icon) { badges.appendChild(badgeFor(icon)); });
        row.appendChild(badges);

        catEl.appendChild(row);
      });

      wrap.appendChild(catEl);
    });

    return { el: wrap, anyVisible: anyVisible };
  }

  function buildLocationCard(loc, dateStr) {
    var card = document.createElement("article");
    card.className = "loc-card";

    var header = document.createElement("div");
    header.className = "loc-header";
    var left = document.createElement("div");
    var name = document.createElement("h2");
    name.className = "loc-name";
    name.textContent = loc.name;
    left.appendChild(name);
    if (loc.hours.length) {
      var hours = document.createElement("div");
      hours.className = "loc-hours";
      loc.hours.forEach(function (h) {
        var s = document.createElement("span");
        s.textContent = h;
        hours.appendChild(s);
      });
      left.appendChild(hours);
    }
    header.appendChild(left);

    var status = liveStatus(loc, dateStr);
    if (status) {
      var pill = document.createElement("span");
      pill.className = "status-pill " + (/open/i.test(status) ? "open" : "closed");
      pill.textContent = status;
      header.appendChild(pill);
    }
    card.appendChild(header);

    if (!loc.meals.length) {
      var none = document.createElement("p");
      none.className = "no-meals";
      none.textContent = "No menu posted for this date.";
      card.appendChild(none);
      return { el: card, anyVisible: true };
    }

    var activeIdx = state.activeMeal[loc.slug] || 0;
    if (activeIdx >= loc.meals.length) activeIdx = 0;

    var bodies = loc.meals.map(buildMealBody);
    var hasFilters = !!(state.search.trim() || state.include.size || state.exclude.size);

    // If a search/filter is active but the manually-selected tab has no
    // matches, jump to the first tab that does (without overwriting the
    // user's actual tab preference, so it reverts once filters clear).
    var displayIdx = activeIdx;
    if (hasFilters && !bodies[displayIdx].anyVisible) {
      var matchIdx = bodies.findIndex(function (b) { return b.anyVisible; });
      if (matchIdx !== -1) displayIdx = matchIdx;
    }

    var tabs = document.createElement("div");
    tabs.className = "meal-tabs";
    var bodyHolder = document.createElement("div");

    if (loc.meals.length > 1) {
      loc.meals.forEach(function (meal, idx) {
        var t = document.createElement("button");
        t.type = "button";
        t.className = "meal-tab" + (idx === displayIdx ? " active" : "");
        t.textContent = meal.name.replace(/^Fall - /, "");
        t.addEventListener("click", function () {
          state.activeMeal[loc.slug] = idx;
          render();
        });
        tabs.appendChild(t);
      });
      card.appendChild(tabs);
    }

    bodyHolder.appendChild(bodies[displayIdx].el);
    card.appendChild(bodyHolder);

    var visible = !hasFilters || bodies[displayIdx].anyVisible;
    return { el: card, anyVisible: visible };
  }

  function scopeDates() {
    if (!state.search.trim() || !state.searchAllDays) return [state.date];
    return state.data.dates.map(function (d) { return d.date; });
  }

  function dateHeaderText(dateStr) {
    var meta = state.data.dates.find(function (d) { return d.date === dateStr; });
    if (!meta) return dateStr;
    var relative = { Yesterday: 1, Today: 1, Tomorrow: 1 };
    return relative[meta.label] ? meta.label + " — " + meta.display : meta.label;
  }

  function renderLocations() {
    els.locations.innerHTML = "";
    var dates = scopeDates();
    var multiDay = dates.length > 1;
    var visibleCount = 0;

    dates.forEach(function (dateStr) {
      var dateBlock = state.data.by_date[dateStr];
      if (!dateBlock) return;

      var cards = dateBlock.locations
        .map(function (loc) { return buildLocationCard(loc, dateStr); })
        .filter(function (built) { return built.anyVisible; });

      if (cards.length === 0) return;
      visibleCount += cards.length;

      if (multiDay) {
        var header = document.createElement("h3");
        header.className = "date-section-header";
        header.textContent = dateHeaderText(dateStr);
        els.locations.appendChild(header);
      }
      cards.forEach(function (built) { els.locations.appendChild(built.el); });
    });

    els.emptyState.hidden = visibleCount > 0;
  }

  var searchDebounce;
  els.search.addEventListener("input", function () {
    clearTimeout(searchDebounce);
    var val = els.search.value;
    searchDebounce = setTimeout(function () {
      state.search = val;
      renderLocations();
    }, 120);
  });

  function render() {
    renderDateTabs();
    renderLocations();
  }

  var loadedDay = null;
  var loadedAt = 0;

  function load() {
    return fetch("data/menus.json", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        var prevToday = loadedDay;
        var today = relabelDates(data);
        state.data = data;
        loadedDay = today;
        loadedAt = Date.now();
        // Keep the user's picked date across refreshes, unless the day rolled over.
        var keep = state.date && prevToday === today &&
          data.dates.some(function (d) { return d.date === state.date; });
        if (!keep) {
          var todayEntry = data.dates.find(function (d) { return d.date === today; });
          var upcoming = data.dates.find(function (d) { return d.date >= today; });
          var fallback = upcoming || data.dates[data.dates.length - 1];
          state.date = todayEntry ? todayEntry.date : (fallback && fallback.date);
        }
        els.updatedAt.textContent = fmtUpdated(data.generated_at);
        render();
      });
  }

  loadPrefs();
  renderFilterRow();
  els.searchAllDays.checked = state.searchAllDays;

  // Tabs left open (or restored from the background) pick up new data and
  // roll "Today" over at midnight without a manual reload.
  function refreshIfStale() {
    if (!state.data) return;
    if (pacificNow().date !== loadedDay || Date.now() - loadedAt > 30 * 60 * 1000) {
      load().catch(function () { /* keep showing what we have */ });
    } else {
      render();
    }
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") refreshIfStale();
  });
  setInterval(refreshIfStale, 5 * 60 * 1000);

  load()
    .catch(function (err) {
      els.updatedAt.textContent = "Could not load menu data";
      els.locations.innerHTML = "<p style='color:var(--text-muted)'>Failed to load data/menus.json (" + err.message + "). If you opened this file directly, serve it over HTTP instead (e.g. <code>python -m http.server</code>) since browsers block local file fetches.</p>";
    });

  initTheme();
})();
