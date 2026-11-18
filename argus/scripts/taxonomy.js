/**
 * taxonomy.js — 相马经 task-domain taxonomy + mechanical classifier.
 *
 * Shared by ledger.js (validation), import.js (classification on import) and
 * the backfill tooling. The taxonomy is task-oriented (the community's biggest
 * directories organize by provider instead — we deliberately differ).
 */
"use strict";

const CATEGORIES = [
  "document-processing",
  "data-analysis",
  "browser-automation",
  "testing-qa",
  "frontend-ui",
  "backend-api",
  "devops-cloud",
  "security",
  "writing-content",
  "design-media",
  "product-marketing",
  "meta-tooling",
  "other",
];

/** keyword -> category signals for mechanical classification */
const KEYWORDS = {
  "document-processing": ["pdf", "docx", "xlsx", "xls", "csv", "tsv", "word", "excel", "powerpoint", "pptx", "office", "spreadsheet", "表格", "文档", "表单", "ocr", "extraction", "merge", "forms", "invoice", "document", "documents", "markdown", "sheet"],
  "data-analysis": ["data", "sql", "pandas", "duckdb", "database", "analytics", "chart", "visualization", "dashboard", "statistics", "分析", "数据", "统计", "图表", "dataset", "bigquery", "clickhouse"],
  "browser-automation": ["browser", "playwright", "puppeteer", "selenium", "scraping", "crawl", "webpage", "headless", "anti-detect", "浏览器", "爬取", "automation", "e2e"],
  "testing-qa": ["test", "testing", "qa", "unit", "vitest", "jest", "coverage", "tdd", "mock", "e2e", " Cypress", "测试", "质量", "assertion", "regression"],
  "frontend-ui": ["react", "vue", "angular", "svelte", "css", "tailwind", "ui", "ux", "figma", "animation", "component", "webapp", "frontend", "nextjs", "shadcn", "样式", "界面", "responsive", "gsap"],
  "backend-api": ["api", "rest", "graphql", "grpc", "supabase", "postgres", "mysql", "redis", "auth", "server", "endpoint", "claude-api", "openai", "llm", "sdk", "webhook", "后端", "接口", "数据库"],
  "devops-cloud": ["docker", "kubernetes", "k8s", "terraform", "deploy", "deployment", "vercel", "cloudflare", "netlify", "aws", "gcp", "azure", "ci", "pipeline", "observability", "sentry", "datadog", "部署", "运维", "nginx"],
  "security": ["security", "vulnerability", "pentest", "exploit", "scanner", "secret", "injection", "owasp", "扫描", "安全", "漏洞", "渗透", "credential", "trust"],
  "writing-content": ["writing", "copywriting", "blog", "seo", "content", "translation", "documentation", "docs", "editorial", "newsletter", "写作", "文案", "翻译", "内容", "haiku", "summarize"],
  "design-media": ["image", "video", "audio", "design", "canvas", "art", "illustration", "photo", "font", "color", "brand", "logo", "remotion", "design-system", "设计", "图片", "视频", "音频", "品牌", "配色", "算法艺术"],
  "product-marketing": ["marketing", "launch", "ab-test", "cro", "onboarding", "paywall", "popup", "ads", "growth", "product", "pm", "roadmap", "用户", "增长", "营销", "投放", "转化"],
  "meta-tooling": ["agent", "mcp", "workflow", "ledger", "memory", "session", "hook", "prompt", "context", "tooling", "智能体", "工作流", "评估", "scout", "judge", "claude-code", "subagent"],
};

const CAT_ALIASES = {
  "document": "document-processing",
  "documents": "document-processing",
  "office": "document-processing",
  "data": "data-analysis",
  "browser": "browser-automation",
  "testing": "testing-qa",
  "qa": "testing-qa",
  "frontend": "frontend-ui",
  "ui": "frontend-ui",
  "backend": "backend-api",
  "api": "backend-api",
  "devops": "devops-cloud",
  "cloud": "devops-cloud",
  "security": "security",
  "writing": "writing-content",
  "content": "writing-content",
  "design": "design-media",
  "media": "design-media",
  "marketing": "product-marketing",
  "product": "product-marketing",
  "meta": "meta-tooling",
  "tooling": "meta-tooling",
};

/** Map a free-form category hint to a taxonomy entry; unknown -> null */
function normalizeCategory(hint) {
  if (!hint) return null;
  const h = String(hint).trim().toLowerCase();
  if (CATEGORIES.includes(h)) return h;
  return CAT_ALIASES[h] || null;
}

/**
 * Mechanical classifier: score categories by keyword hits over the skill's
 * surface text. `hint` (e.g. the import keyword's domain) wins when present.
 */
function classify({ id = "", name = "", description = "", bestFor = [], hint = null } = {}) {
  const normalized = normalizeCategory(hint);
  if (normalized) return normalized;
  // NB: head signal = the skill NAME only — the id path contains repo dirs
  // like "skills/" whose generic words poisoned category matching (live bug)
  const surface = (name + " " + description + " " + bestFor.join(" ")).toLowerCase();
  const head = name.toLowerCase();
  let best = "other", bestScore = 0;
  for (const [cat, kws] of Object.entries(KEYWORDS)) {
    let score = 0;
    for (const kw of kws) if (surface.includes(kw)) score += kw.length > 4 ? 2 : 1;
    for (const kw of kws) if (head.includes(kw)) score += 2;
    if (score > bestScore) { best = cat; bestScore = score; }
  }
  return bestScore > 0 ? best : "other";
}

module.exports = { CATEGORIES, KEYWORDS, CAT_ALIASES, normalizeCategory, classify };
