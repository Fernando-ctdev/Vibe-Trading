import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import i18n from "@/i18n";
import { SwarmTeams } from "../SwarmTeams";

const apiMock = vi.hoisted(() => ({ listSwarmPresetCatalog: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: apiMock }));

function makeCatalog() {
  const fullInstructions = Array.from({ length: 5 }, (_, index) => `Review market structure, phase ${index + 1}.`).join("\n");
  return [
    {
      name: "alpha_team",
      title: "Alpha Team",
      description: "A focused research team.",
      source: "bundled",
      agents: [
        {
          id: "analyst",
          role: "Lead analyst",
          instructions: fullInstructions,
          tools: ["get_market_data"],
          skills: ["technical-analysis"],
          limits: { max_iterations: 7 },
        },
      ],
      tasks: [
        {
          id: "task-review",
          agent_id: "analyst",
          prompt_template: "Review {symbol} and report the key risks.",
          depends_on: [],
          input_from: { market: "task-market" },
        },
      ],
    },
    {
      name: "beta_team",
      title: "Beta Team",
      source: "user",
      agents: [{ id: "analyst", role: "Risk analyst", instructions: "Assess downside only." }],
      tasks: [],
    },
  ];
}

beforeEach(() => {
  apiMock.listSwarmPresetCatalog.mockReset();
});

beforeAll(async () => { await i18n.changeLanguage("en"); });

it("shows task prompts, ownership, dependencies, inputs, and every team variant", async () => {
  apiMock.listSwarmPresetCatalog.mockResolvedValue(makeCatalog());
  render(<SwarmTeams />);

  expect(await screen.findByText("Review {symbol} and report the key risks.")).toBeInTheDocument();
  expect(screen.getByText("analyst")).toBeInTheDocument();
  expect(screen.getByText("Lead analyst")).toBeInTheDocument();
  expect(screen.getByText(/task-market/)).toBeInTheDocument();
  expect(screen.getByText("Alpha Team")).toBeInTheDocument();
  expect(screen.getByText("Beta Team")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: /Agents/ }));
  const alphaCard = screen.getByText("Lead analyst").closest("article");
  expect(alphaCard).not.toBeNull();
  const card = within(alphaCard!);
  const instructions = card.getByText(/Review market structure, phase 1/);
  expect(instructions).toHaveClass("line-clamp-3");
  expect(instructions).toHaveTextContent("Review market structure, phase 5.");
  const expand = card.getByRole("button", { name: "Show full instructions" });
  expect(expand).toHaveAttribute("aria-expanded", "false");
  expect(expand).toHaveAttribute("aria-controls", instructions.id);
  fireEvent.click(expand);
  expect(instructions).not.toHaveClass("line-clamp-3");
  expect(instructions).toHaveTextContent("Review market structure, phase 5.");
  const collapse = card.getByRole("button", { name: "Show less" });
  expect(collapse).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(collapse);
  expect(instructions).toHaveClass("line-clamp-3");
  expect(card.getByRole("button", { name: "Show full instructions" })).toHaveAttribute("aria-expanded", "false");

  expect(card.getByText("analyst")).toBeInTheDocument();
  expect(card.getByText("Alpha Team")).toBeInTheDocument();
  expect(card.getByText("get_market_data")).toBeInTheDocument();
  expect(card.getByText("technical-analysis")).toBeInTheDocument();
  expect(card.getByText("Max iterations")).toBeInTheDocument();
  expect(card.getByText("7")).toBeInTheDocument();
  expect(screen.getByText("Assess downside only.")).toBeInTheDocument();
  expect(screen.getByText("Risk analyst")).toBeInTheDocument();
  expect(screen.getByText("Max iterations")).toBeInTheDocument();
  expect(screen.queryByText("Timeout (seconds)")).not.toBeInTheDocument();
  expect(screen.queryByText("Max retries")).not.toBeInTheDocument();
});

it("shows loading, empty, and recoverable error states", async () => {
  let resolveCatalog!: (catalog: []) => void;
  apiMock.listSwarmPresetCatalog.mockReturnValue(new Promise((resolve) => { resolveCatalog = resolve; }));
  const { rerender } = render(<SwarmTeams />);
  expect(screen.getByRole("status", { name: "Loading team catalog…" })).toBeInTheDocument();

  resolveCatalog([]);
  expect(await screen.findByText("No team presets found.")).toBeInTheDocument();

  apiMock.listSwarmPresetCatalog.mockResolvedValue([]);
  apiMock.listSwarmPresetCatalog.mockRejectedValueOnce(new Error("Catalog unavailable"));
  rerender(<SwarmTeams key="retry" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Catalog unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(apiMock.listSwarmPresetCatalog).toHaveBeenCalledTimes(3));
});
