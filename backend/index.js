import "dotenv/config";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { tavily } from "@tavily/core";

const REQUIRED_RESEARCH_AREAS = [
  "business model and revenue quality",
  "recent financial performance",
  "growth drivers and competitive position",
  "valuation signals",
  "major risks or red flags",
];

const DRY_RUN = process.argv.includes("--dry-run") || process.env.DRY_RUN === "true";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 12000);

const ResearchState = Annotation.Root({
  company: Annotation(),
  needsResearch: Annotation(),
  researchPlan: Annotation({
    reducer: (_, value) => value,
    default: () => [],
  }),
  searches: Annotation({
    reducer: (current, value) => current.concat(value ?? []),
    default: () => [],
  }),
  findings: Annotation({
    reducer: (current, value) => current.concat(value ?? []),
    default: () => [],
  }),
  report: Annotation(),
});

const model = new ChatGoogleGenerativeAI({
  model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
  apiKey: process.env.GOOGLE_API_KEY ?? process.env.API_KEY,
  temperature: 0.2,
});

const searchClient = tavily({
  apiKey: process.env.TAVILY_API_KEY,
});

function parseCompany() {
  const company = process.argv
    .slice(2)
    .filter((arg) => arg !== "--dry-run")
    .join(" ")
    .trim();

  if (!company) {
    throw new Error('Usage: npm run research -- "Company Name"');
  }

  return company;
}

function cleanJson(text) {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

async function askJson(messages, fallback) {
  if (DRY_RUN) return fallback;

  try {
    const response = await withTimeout(model.invoke(messages), REQUEST_TIMEOUT_MS);
    return JSON.parse(cleanJson(response.content.toString()));
  } catch {
    return fallback;
  }
}

async function withTimeout(task, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms);
  });

  try {
    return await Promise.race([task, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, options) {
  if (DRY_RUN) {
    return {
      answer: `Dry-run evidence placeholder for: ${query}`,
      results: [],
    };
  }

  return withTimeout(searchClient.search(query, options), REQUEST_TIMEOUT_MS);
}

function routerNode(state) {
  const knownTicker = /\([A-Z]{1,6}\)|\b[A-Z]{2,6}\b/.test(state.company);

  return {
    needsResearch: !knownTicker,
  };
}

function routeAfterRouter(state) {
  return state.needsResearch ? "research" : "orchestrator";
}

async function researchNode(state) {
  const query = `${state.company} investor relations stock ticker business overview`;

  try {
    const result = await searchWeb(query, {
      maxResults: 4,
      searchDepth: "basic",
      includeAnswer: true,
    });

    const findings = (result.results ?? []).map((item) => ({
      area: "company identity",
      title: item.title,
      url: item.url,
      summary: item.content,
    }));

    if (result.answer) {
      findings.unshift({
        area: "company identity",
        title: "Tavily answer",
        url: null,
        summary: result.answer,
      });
    }

    return {
      searches: [{ area: "company identity", query }],
      findings,
    };
  } catch (error) {
    return {
      searches: [{ area: "company identity", query }],
      findings: [
        {
          area: "company identity",
          title: "Research unavailable",
          url: null,
          summary: `Initial lookup failed: ${error.message}`,
        },
      ],
    };
  }
}

async function orchestratorNode(state) {
  const plan = await askJson(
    [
      new SystemMessage(
        "You plan investment research. Return only JSON with a queries array of 4 to 6 objects. Each object must have area and query."
      ),
      new HumanMessage(
        `Company: ${state.company}\nCover these areas: ${REQUIRED_RESEARCH_AREAS.join(", ")}.`
      ),
    ],
    {
      queries: REQUIRED_RESEARCH_AREAS.map((area) => ({
        area,
        query: `${state.company} ${area}`,
      })),
    }
  );

  return {
    researchPlan: plan.queries ?? [],
  };
}

async function workerNode(state) {
  const plan = state.researchPlan.length
    ? state.researchPlan
    : REQUIRED_RESEARCH_AREAS.map((area) => ({
        area,
        query: `${state.company} ${area}`,
      }));

  const completed = [];
  const findings = [];

  for (const item of plan) {
    try {
      const result = await searchWeb(item.query, {
        maxResults: 3,
        searchDepth: "advanced",
        includeAnswer: true,
      });

      completed.push({ area: item.area, query: item.query });

      if (result.answer) {
        findings.push({
          area: item.area,
          title: "Tavily answer",
          url: null,
          summary: result.answer,
        });
      }

      for (const source of result.results ?? []) {
        findings.push({
          area: item.area,
          title: source.title,
          url: source.url,
          summary: source.content,
        });
      }
    } catch (error) {
      findings.push({
        area: item.area,
        title: "Search failed",
        url: null,
        summary: `${item.query}: ${error.message}`,
      });
    }
  }

  return {
    searches: completed,
    findings,
  };
}

async function reducerNode(state) {
  const evidence = state.findings
    .slice(0, 24)
    .map((item, index) => {
      const source = item.url ? ` (${item.url})` : "";
      return `${index + 1}. [${item.area}] ${item.title}${source}: ${item.summary}`;
    })
    .join("\n");

  const report = await askJson(
    [
      new SystemMessage(
        [
          "You are an investment research analyst.",
          "Use the evidence, be balanced, and do not invent numbers.",
          "Return only JSON with: decision, conviction, thesis, positives, risks, nextQuestions, evidenceUsed.",
          "decision must be INVEST, PASS, or WATCHLIST.",
        ].join(" ")
      ),
      new HumanMessage(`Company: ${state.company}\n\nEvidence:\n${evidence}`),
    ],
    {
      decision: "WATCHLIST",
      conviction: "low",
      thesis: "The agent could not produce a confident view from the available evidence.",
      positives: [],
      risks: ["Research sources were incomplete or unavailable."],
      nextQuestions: ["Verify latest filings, valuation, and management commentary."],
      evidenceUsed: state.findings.slice(0, 6),
    }
  );

  return { report };
}

function completeNode(state) {
  return state;
}

function buildGraph() {
  return new StateGraph(ResearchState)
    .addNode("router", routerNode)
    .addNode("research", researchNode)
    .addNode("orchestrator", orchestratorNode)
    .addNode("worker", workerNode)
    .addNode("reducer", reducerNode)
    .addNode("complete", completeNode)
    .addEdge(START, "router")
    .addConditionalEdges("router", routeAfterRouter, {
      research: "research",
      orchestrator: "orchestrator",
    })
    .addEdge("research", "orchestrator")
    .addEdge("orchestrator", "worker")
    .addEdge("worker", "reducer")
    .addEdge("reducer", "complete")
    .addEdge("complete", END)
    .compile();
}

function printReport(result) {
  console.log(JSON.stringify(result.report, null, 2));
}

async function main() {
  const company = parseCompany();
  const graph = buildGraph();
  const result = await graph.invoke({ company });

  printReport(result);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
