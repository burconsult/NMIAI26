const dashboardData = {
  challenges: [
    {
      name: "NGD",
      longName: "NorgesGruppen Data",
      normalized: 93.67,
      raw: "0.6663",
      rank: "225 / 361",
      beat: "37.7%",
      accent: "from-emerald-400 to-cyan-400",
    },
    {
      name: "Tripletex",
      longName: "Tripletex",
      normalized: 46.59,
      raw: "48.5751",
      rank: "188 / 412",
      beat: "54.4%",
      accent: "from-orange-400 to-coral",
    },
    {
      name: "Astar",
      longName: "Astar Island",
      normalized: 90.38,
      raw: "240.9127",
      rank: "105 / 397",
      beat: "73.6%",
      accent: "from-cyan-400 to-blue-500",
    },
  ],
  codeSplit: [
    { label: "Tripletex", value: 36623, display: "36.6k", color: "bg-slate-950 dark:bg-white" },
    { label: "Grocery Bot", value: 5195, display: "5.2k", color: "bg-emerald-400" },
    { label: "Astar", value: 4322, display: "4.3k", color: "bg-cyan-400" },
    { label: "NGD", value: 2212, display: "2.2k", color: "bg-orange-400" },
  ],
  activity: [
    { label: "Tripletex attempts", value: "409" },
    { label: "Astar rounds", value: "22" },
    { label: "NGD submissions", value: "22" },
    { label: "Bench trials", value: "768" },
  ],
};

function renderChallenges() {
  const container = document.getElementById("challenge-grid");
  container.innerHTML = dashboardData.challenges
    .map(
      (challenge) => `
        <article class="rounded-3xl border border-slate-200 bg-slate-50 p-5 dark:border-white/10 dark:bg-white/5">
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="metric-kicker">${challenge.name}</p>
              <h3 class="mt-2 font-display text-xl font-bold text-slate-950 dark:text-white">${challenge.longName}</h3>
            </div>
            <div class="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 dark:bg-white/10 dark:text-slate-200 dark:ring-white/10">
              ${challenge.rank}
            </div>
          </div>
          <div class="mt-5 space-y-3">
            <div class="flex items-end justify-between gap-4">
              <div>
                <p class="metric-kicker">Normalized</p>
                <p class="mt-1 font-display text-4xl font-bold text-slate-950 dark:text-white">${challenge.normalized.toFixed(2)}</p>
              </div>
              <div class="text-right">
                <p class="metric-kicker">Raw</p>
                <p class="mt-1 text-sm font-semibold text-slate-700 dark:text-slate-200">${challenge.raw}</p>
              </div>
            </div>
            <div class="h-2.5 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
              <div class="h-full rounded-full bg-gradient-to-r ${challenge.accent}" style="width:${challenge.normalized}%"></div>
            </div>
            <div class="flex items-center justify-between text-sm text-slate-500 dark:text-slate-400">
              <span>Field beaten</span>
              <span class="font-semibold text-slate-700 dark:text-slate-200">${challenge.beat}</span>
            </div>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderCodeSplit() {
  const container = document.getElementById("code-split");
  const max = Math.max(...dashboardData.codeSplit.map((item) => item.value));
  container.innerHTML = dashboardData.codeSplit
    .map(
      (item) => `
        <div class="space-y-2">
          <div class="flex items-center justify-between gap-4 text-sm">
            <span class="font-semibold text-slate-700 dark:text-slate-200">${item.label}</span>
            <span class="text-slate-500 dark:text-slate-400">${item.display}</span>
          </div>
          <div class="h-3 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
            <div class="h-full rounded-full ${item.color}" style="width:${(item.value / max) * 100}%"></div>
          </div>
        </div>
      `,
    )
    .join("");
}

function renderActivity() {
  const container = document.getElementById("activity-grid");
  container.innerHTML = dashboardData.activity
    .map(
      (item, index) => `
        <article class="rounded-3xl p-5 ${index === 0 ? "bg-slate-950 text-white dark:bg-white/10" : "bg-slate-100 dark:bg-white/5"}">
          <p class="metric-kicker ${index === 0 ? "!text-white/60" : ""}">${item.label}</p>
          <p class="mt-3 font-display text-4xl font-bold ${index === 0 ? "text-white" : "text-slate-950 dark:text-white"}">${item.value}</p>
        </article>
      `,
    )
    .join("");
}

function initThemeToggle() {
  const button = document.getElementById("theme-toggle");
  if (!button) return;

  button.addEventListener("click", () => {
    const nextDark = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", nextDark);
    localStorage.setItem("nmiai-theme", nextDark ? "dark" : "light");
  });
}

renderChallenges();
renderCodeSplit();
renderActivity();
initThemeToggle();
