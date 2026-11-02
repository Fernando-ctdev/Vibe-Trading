import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import i18n from "@/i18n";
import { SwarmTeams } from "../SwarmTeams";

const apiMock = vi.hoisted(() => ({
  listSwarmPresetCatalog: vi.fn(),
  getSwarmPresetSource: vi.fn(),
  validateSwarmPreset: vi.fn(),
  createSwarmPreset: vi.fn(),
  saveSwarmPresetSource: vi.fn(),
  listToolCatalog: vi.fn(),
  listSkillCatalog: vi.fn(),
}));

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
  apiMock.getSwarmPresetSource.mockReset();
  apiMock.validateSwarmPreset.mockReset();
  apiMock.createSwarmPreset.mockReset();
  apiMock.saveSwarmPresetSource.mockReset();
  apiMock.listToolCatalog.mockReset();
  apiMock.listSkillCatalog.mockReset();
  apiMock.listToolCatalog.mockResolvedValue([]);
  apiMock.listSkillCatalog.mockResolvedValue([]);
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
  expect(screen.queryByText("Assess downside only.")).not.toBeInTheDocument();
  expect(screen.queryByText("Timeout (seconds)")).not.toBeInTheDocument();
  expect(screen.queryByText("Max retries")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "My presets" }));
  expect(await screen.findByText("Beta Team")).toBeInTheDocument();
  expect(screen.getByText("Assess downside only.")).toBeInTheDocument();
  expect(screen.getByText("Risk analyst")).toBeInTheDocument();
  expect(screen.queryByText("Alpha Team")).not.toBeInTheDocument();
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

it("opens a bundled preset, validates the exact YAML, previews its layers, and saves with its revision", async () => {
  const yamlText = "# keep comments and order\nname: alpha_team\nagents: []\ntasks: []\n";
  apiMock.listSwarmPresetCatalog.mockResolvedValue(makeCatalog());
  apiMock.getSwarmPresetSource.mockResolvedValue({ yaml_text: yamlText, source: "bundled", revision: "rev-bundled" });
  apiMock.validateSwarmPreset.mockResolvedValue({
    valid: true,
    errors: [],
    warnings: ["No optional description was set."],
    layers: [[{ task_id: "research", agent_id: "analyst" }], [{ task_id: "summary", agent_id: "analyst" }]],
  });
  apiMock.saveSwarmPresetSource.mockResolvedValue(undefined);
  render(<SwarmTeams />);

  const team = (await screen.findByText("Alpha Team")).closest("article");
  fireEvent.click(within(team!).getByRole("button", { name: "Edit YAML" }));
  const editor = await screen.findByRole("region", { name: "Preset YAML editor" });
  fireEvent.click(within(editor).getByRole("button", { name: "YAML" }));
  const yaml = within(editor).getByRole("textbox", { name: "YAML source" });
  await waitFor(() => expect(yaml).toHaveValue(yamlText));
  expect(within(editor).getByRole("button", { name: "Save preset" })).toBeDisabled();

  fireEvent.click(within(editor).getByRole("button", { name: "Validate" }));
  expect(await within(editor).findByText("No optional description was set.")).toBeInTheDocument();
  expect(within(editor).getByText("research")).toBeInTheDocument();
  expect(within(editor).getByText("summary")).toBeInTheDocument();
  expect(within(editor).getByRole("button", { name: "Save preset" })).toBeEnabled();

  fireEvent.click(within(editor).getByRole("button", { name: "Save preset" }));
  await waitFor(() => expect(apiMock.saveSwarmPresetSource).toHaveBeenCalledWith("alpha_team", yamlText, "rev-bundled"));

  expect(screen.getByRole("button", { name: "My presets" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("region", { name: "Preset YAML editor" })).not.toBeInTheDocument();
  expect(await screen.findByText("Beta Team")).toBeInTheDocument();
  expect(screen.queryByText("Alpha Team")).not.toBeInTheDocument();
});

it("creates a new user preset only after successful validation", async () => {
  const yamlText = "# new team\nname: fresh_team\nagents: []\ntasks: []\n";
  apiMock.listSwarmPresetCatalog.mockResolvedValue(makeCatalog());
  apiMock.validateSwarmPreset.mockResolvedValue({ valid: true, errors: [], warnings: [], layers: [] });
  apiMock.createSwarmPreset.mockResolvedValue(undefined);
  render(<SwarmTeams />);

  fireEvent.click(await screen.findByRole("button", { name: "New preset" }));
  const editor = await screen.findByRole("region", { name: "Preset YAML editor" });
  fireEvent.click(within(editor).getByRole("button", { name: "YAML" }));
  const yaml = within(editor).getByRole("textbox", { name: "YAML source" });
  fireEvent.change(yaml, { target: { value: yamlText } });
  fireEvent.click(within(editor).getByRole("button", { name: "Validate" }));
  await waitFor(() => expect(apiMock.validateSwarmPreset).toHaveBeenCalledWith(yamlText));
  const editedYaml = `${yamlText}# changed after preview\n`;
  fireEvent.change(yaml, { target: { value: editedYaml } });
  expect(within(editor).getByRole("button", { name: "Save preset" })).toBeDisabled();
  fireEvent.click(within(editor).getByRole("button", { name: "Validate" }));
  await waitFor(() => expect(apiMock.validateSwarmPreset).toHaveBeenLastCalledWith(editedYaml));
  fireEvent.click(within(editor).getByRole("button", { name: "Save preset" }));

  await waitFor(() => expect(apiMock.createSwarmPreset).toHaveBeenCalledWith(editedYaml));
  expect(apiMock.saveSwarmPresetSource).not.toHaveBeenCalled();

  expect(screen.getByRole("button", { name: "My presets" })).toHaveAttribute("aria-pressed", "true");
  await waitFor(() => expect(apiMock.listSwarmPresetCatalog).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("Beta Team")).toBeInTheDocument();
});

it("shows backend validation errors, warnings, and any available layers without enabling save", async () => {
  apiMock.listSwarmPresetCatalog.mockResolvedValue(makeCatalog());
  apiMock.getSwarmPresetSource.mockResolvedValue({ yaml_text: "name: alpha_team\n", source: "user", revision: "rev-1" });
  apiMock.validateSwarmPreset.mockRejectedValue({
    status: 422,
    detail: {
      valid: false,
      errors: ["Unknown agent 'missing'"],
      warnings: ["Prompt template has no placeholders."],
      layers: [[{ task_id: "research", agent_id: "missing" }]],
    },
  });
  render(<SwarmTeams />);

  const team = (await screen.findByText("Alpha Team")).closest("article");
  fireEvent.click(within(team!).getByRole("button", { name: "Edit YAML" }));
  const editor = await screen.findByRole("region", { name: "Preset YAML editor" });
  fireEvent.click(within(editor).getByRole("button", { name: "Validate" }));

  expect(await within(editor).findByText("Unknown agent 'missing'")).toBeInTheDocument();
  expect(within(editor).getByText("Prompt template has no placeholders.")).toBeInTheDocument();
  expect(within(editor).getByText("research")).toBeInTheDocument();
  expect(within(editor).getByRole("button", { name: "Save preset" })).toBeDisabled();
});

it("keeps the draft when a save conflicts, fetches the latest source, and makes overwrite explicit", async () => {
  const draft = "# my reviewed draft\nname: alpha_team\nagents: []\ntasks: []\n";
  const latest = "# newer server copy\nname: alpha_team\nagents: []\ntasks: []\n";
  apiMock.listSwarmPresetCatalog.mockResolvedValue(makeCatalog());
  apiMock.getSwarmPresetSource
    .mockResolvedValueOnce({ yaml_text: draft, source: "user", revision: "rev-old" })
    .mockResolvedValueOnce({ yaml_text: latest, source: "user", revision: "rev-latest" });
  apiMock.validateSwarmPreset.mockResolvedValue({ valid: true, errors: [], warnings: [], layers: [] });
  apiMock.saveSwarmPresetSource.mockRejectedValueOnce({ status: 409, message: "Conflict" }).mockResolvedValue(undefined);
  render(<SwarmTeams />);

  const team = (await screen.findByText("Alpha Team")).closest("article");
  fireEvent.click(within(team!).getByRole("button", { name: "Edit YAML" }));
  const editor = await screen.findByRole("region", { name: "Preset YAML editor" });
  fireEvent.click(within(editor).getByRole("button", { name: "YAML" }));
  const yaml = within(editor).getByRole("textbox", { name: "YAML source" });
  await waitFor(() => expect(yaml).toHaveValue(draft));
  fireEvent.change(yaml, { target: { value: draft } });
  fireEvent.click(within(editor).getByRole("button", { name: "Validate" }));
  await waitFor(() => expect(within(editor).getByRole("button", { name: "Save preset" })).toBeEnabled());
  fireEvent.click(within(editor).getByRole("button", { name: "Save preset" }));

  const conflictAlert = await within(editor).findByRole("alert");
  expect(conflictAlert).toHaveTextContent("Preset changed on the server.");
  expect(conflictAlert).toHaveTextContent("Your draft is preserved.");
  expect(yaml).toHaveValue(draft);
  expect(within(editor).getByLabelText("Latest server source")).toHaveTextContent("# newer server copy");
  expect(apiMock.getSwarmPresetSource).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");

  fireEvent.click(within(editor).getByRole("button", { name: "Save draft over latest" }));
  await waitFor(() => expect(apiMock.saveSwarmPresetSource).toHaveBeenLastCalledWith("alpha_team", draft, "rev-latest"));
  expect(await screen.findByRole("button", { name: "My presets" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("region", { name: "Preset YAML editor" })).not.toBeInTheDocument();
});

it("splits sources into tabs, shows an effective override only in My presets, and toggles views in both tabs", async () => {
  apiMock.listSwarmPresetCatalog.mockResolvedValue([
    { name: "gamma_team", title: "Gamma Team", source: "bundled", agents: [{ id: "analyst", role: "Lead analyst", instructions: "Bundled instructions." }], tasks: [] },
    { name: "alpha_team", title: "Alpha Override", source: "user", agents: [{ id: "reviewer", role: "Override reviewer", instructions: "Override instructions." }], tasks: [] },
    { name: "beta_team", title: "Beta Team", source: "user", agents: [{ id: "risk", role: "Risk analyst", instructions: "Risk instructions." }], tasks: [] },
  ]);
  render(<SwarmTeams />);

  expect(await screen.findByText("Gamma Team")).toBeInTheDocument();
  expect(screen.queryByText("Alpha Override")).not.toBeInTheDocument();
  expect(screen.queryByText("Beta Team")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "My presets" }));
  expect(await screen.findByText("Alpha Override")).toBeInTheDocument();
  expect(screen.getAllByText("Alpha Override")).toHaveLength(1);
  expect(screen.getByText("Beta Team")).toBeInTheDocument();
  expect(screen.queryByText("Gamma Team")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Agents" }));
  expect(screen.getByText("Override instructions.")).toBeInTheDocument();
  expect(screen.getByText("Risk instructions.")).toBeInTheDocument();
  expect(screen.queryByText("Bundled instructions.")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "System" }));
  expect(await screen.findByText("Bundled instructions.")).toBeInTheDocument();
  expect(screen.queryByText("Override instructions.")).not.toBeInTheDocument();
  expect(screen.queryByText("Risk instructions.")).not.toBeInTheDocument();
});

it("offers New preset in both tabs and shows localized empty states per source", async () => {
  apiMock.listSwarmPresetCatalog.mockResolvedValue([
    { name: "alpha_team", title: "Alpha Team", source: "bundled", agents: [], tasks: [] },
  ]);
  render(<SwarmTeams />);

  expect(await screen.findByText("Alpha Team")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "New preset" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "My presets" }));
  expect(await screen.findByText("You have no presets yet.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "New preset" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Agents" }));
  expect(screen.getByText("No agents in your presets.")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "System" }));
  fireEvent.click(screen.getByRole("button", { name: "Agents" }));
  expect(screen.getByText("No agents found.")).toBeInTheDocument();
});

const richYaml = [
  "# team comments preserved",
  "name: alpha_team",
  "model_name: gpt-x",
  "agents:",
  "  - id: analyst",
  "    role: Lead analyst",
  "    system_prompt: Review everything.",
  "    tools:",
  "      - get_market_data",
  "tasks:",
  "  - id: task-market",
  "    agent_id: analyst",
  "    prompt_template: Fetch {symbol} market data.",
  "    depends_on: []",
  "  - id: task-review",
  "    agent_id: analyst",
  "    prompt_template: Review {symbol}.",
  "    depends_on:",
  "      - task-market",
  "    input_from:",
  "      market: task-market",
  "  - id: task-summary",
  "    agent_id: analyst",
  "    prompt_template: Summarize findings.",
  "    depends_on:",
  "      - task-review",
  "",
].join("\n");

// task-review loses its upstream dependency but keeps input_from -> task-market.
const detachedYaml = richYaml.replace(
  "    depends_on:\n      - task-market\n    input_from:",
  "    depends_on: []\n    input_from:",
);

function nodeOf(taskId: string): HTMLElement {
  // Query the interactive .react-flow__node wrapper directly: ReactFlow keeps
  // aria-live copies of node labels elsewhere in the DOM.
  const node = document.querySelector(`.react-flow__node[data-id="${taskId}"]`);
  if (!node) throw new Error(`node ${taskId} not found`);
  return node as HTMLElement;
}

function nodeButton(taskId: string, name: string): HTMLElement {
  // jsdom has no layout, so ReactFlow marks unmeasured nodes `visibility: hidden`;
  // label queries stay reliable where the role engine would filter them out.
  const node = nodeOf(taskId);
  const button = Array.from(node.querySelectorAll("button")).find((el) => el.getAttribute("aria-label") === name || el.textContent === name);
  if (!button) throw new Error(`button ${name} not found in node ${taskId}`);
  return button;
}

async function openVisualEditor(yamlText: string) {
  apiMock.listSwarmPresetCatalog.mockResolvedValue(makeCatalog());
  apiMock.getSwarmPresetSource.mockResolvedValue({ yaml_text: yamlText, source: "user", revision: "rev-1" });
  render(<SwarmTeams />);
  const team = (await screen.findByText("Alpha Team")).closest("article");
  fireEvent.click(within(team!).getByRole("button", { name: "Edit YAML" }));
  return await screen.findByRole("region", { name: "Preset YAML editor" });
}

async function validatedYamlDraft(editor: HTMLElement): Promise<string> {
  fireEvent.click(within(editor).getByRole("button", { name: "Validate" }));
  await waitFor(() => expect(apiMock.validateSwarmPreset).toHaveBeenCalled());
  return apiMock.validateSwarmPreset.mock.lastCall?.[0] as string;
}

it("edits the task graph visually while preserving YAML comments, order, and unknown fields", async () => {
  apiMock.validateSwarmPreset.mockResolvedValue({ valid: true, errors: [], warnings: [], layers: [] });
  apiMock.listToolCatalog.mockResolvedValue([{ name: "get_market_data", description: "" }, { name: "web_search", description: "" }]);
  apiMock.listSkillCatalog.mockResolvedValue([{ name: "technical-analysis", source: "bundled", description: "" }]);
  const editor = await openVisualEditor(richYaml);

  expect(nodeOf("task-review")).toBeInTheDocument();
  fireEvent.click(nodeButton("task-review", "Select"));

  const prompt = within(editor).getByLabelText("Prompt template");
  expect(prompt).toHaveValue("Review {symbol}.");
  fireEvent.change(prompt, { target: { value: "Deep review of {symbol}." } });

  // Catalog suggestions load alongside unknown configured values that stay intact.
  expect(editor.querySelector('datalist option[value="web_search"]')).not.toBeNull();
  expect(editor.querySelector('datalist option[value="get_market_data"]')).not.toBeNull();

  const draft = await validatedYamlDraft(editor);
  expect(draft).toContain("# team comments preserved");
  expect(draft).toContain("model_name: gpt-x");
  expect(draft).toContain("Deep review of {symbol}.");
  expect(draft).toContain("input_from:");
  expect(draft).toContain("get_market_data");
});

it("removes a task through the canvas while keeping its agent, and blocks removing a referenced agent", async () => {
  apiMock.validateSwarmPreset.mockResolvedValue({ valid: true, errors: [], warnings: [], layers: [] });
  const editor = await openVisualEditor(richYaml);

  fireEvent.click(nodeButton("task-review", "Select"));
  expect(within(editor).getByRole("button", { name: "Remove agent" })).toBeDisabled();
  expect(within(editor).getByText("This agent is still referenced by tasks. Reassign those tasks before removing it."));

  fireEvent.click(nodeButton("task-review", "Remove task: task-review"));
  expect(document.querySelector('.react-flow__node[data-id="task-review"]')).not.toBeInTheDocument();

  const draft = await validatedYamlDraft(editor);
  expect(draft).toContain("id: analyst");
  expect(draft).not.toContain("task-review");
  expect(draft).toContain("task-summary");
});

it("removing a dependency changes only depends_on and preserves input_from", async () => {
  apiMock.validateSwarmPreset.mockResolvedValue({ valid: true, errors: [], warnings: [], layers: [] });
  const editor = await openVisualEditor(richYaml);

  fireEvent.click(nodeButton("task-summary", "Select"));
  fireEvent.click(within(editor).getByRole("button", { name: "Remove dependency: task-review" }));

  const draft = await validatedYamlDraft(editor);
  expect(draft).toContain("depends_on: []");
  expect(draft).toContain("market: task-market");
});

it("removes one input mapping in place and preserves the comment on the surviving one", async () => {
  const mappingsYaml = richYaml.replace(
    "    input_from:\n      market: task-market",
    "    input_from:\n      market: task-market # raw market data\n      price: task-market # priced data",
  );
  apiMock.validateSwarmPreset.mockResolvedValue({ valid: true, errors: [], warnings: [], layers: [] });
  const editor = await openVisualEditor(mappingsYaml);

  fireEvent.click(nodeButton("task-review", "Select"));
  fireEvent.click(within(editor).getByRole("button", { name: "Remove mapping: market" }));

  const draft = await validatedYamlDraft(editor);
  expect(draft).toContain("price: task-market # priced data");
  expect(draft).not.toContain("market: task-market");
});

it("adds an input mapping on the first free input-N key without overwriting gaps", async () => {
  const gappedYaml = richYaml.replace(
    "    input_from:\n      market: task-market",
    "    input_from:\n      input-1: task-market\n      input-3: task-market",
  );
  apiMock.validateSwarmPreset.mockResolvedValue({ valid: true, errors: [], warnings: [], layers: [] });
  const editor = await openVisualEditor(gappedYaml);

  fireEvent.click(nodeButton("task-review", "Select"));
  fireEvent.click(within(editor).getByRole("button", { name: "Add input mapping" }));

  const draft = await validatedYamlDraft(editor);
  expect(draft).toContain("input-1: task-market");
  expect(draft).toContain("input-3: task-market");
  expect(draft).toContain("input-2: task-market");
});

it("blocks save while input_from references a non-upstream task and offers re-link or mapping removal", async () => {
  apiMock.validateSwarmPreset.mockResolvedValue({ valid: true, errors: [], warnings: [], layers: [] });
  const editor = await openVisualEditor(detachedYaml);

  expect(await within(editor).findByRole("alert")).toHaveTextContent("Save blocked: input mappings are inconsistent with the graph.");
  expect(within(editor).getByRole("button", { name: "Save preset" })).toBeDisabled();

  fireEvent.click(within(editor).getByRole("button", { name: "Re-link dependency" }));
  await waitFor(() => expect(within(editor).queryByRole("alert")).not.toBeInTheDocument());
  const draft = await validatedYamlDraft(editor);
  // Re-link mutates the existing sequence in place, so an empty flow-style
  // depends_on stays flow (`[ task-market ]`) instead of becoming a block list.
  expect(draft).toContain("task-market");
  expect(draft).toContain("market: task-market");
});

it("blocks save allows removing the stale input mapping instead of re-linking", async () => {
  apiMock.validateSwarmPreset.mockResolvedValue({ valid: true, errors: [], warnings: [], layers: [] });
  const editor = await openVisualEditor(detachedYaml);

  await within(editor).findByRole("alert");
  fireEvent.click(within(editor).getByRole("button", { name: "Remove mapping" }));
  await waitFor(() => expect(within(editor).queryByRole("alert")).not.toBeInTheDocument());

  const draft = await validatedYamlDraft(editor);
  expect(draft).not.toContain("market: task-market");
});

it("keeps the graph mapping check live in YAML mode and clears it after repair", async () => {
  apiMock.validateSwarmPreset.mockResolvedValue({ valid: true, errors: [], warnings: [], layers: [] });
  const editor = await openVisualEditor(richYaml);
  fireEvent.click(within(editor).getByRole("button", { name: "YAML" }));
  const yaml = within(editor).getByRole("textbox", { name: "YAML source" });

  // Break the mapping while the canvas is unmounted; the API still returns valid.
  fireEvent.change(yaml, { target: { value: detachedYaml } });
  fireEvent.click(within(editor).getByRole("button", { name: "Validate" }));
  await waitFor(() => expect(within(editor).getByRole("button", { name: "Save preset" })).toBeDisabled());
  expect(within(editor).getByText("Fix the input mappings flagged in the graph before saving.")).toBeInTheDocument();

  // Repairing the draft clears the block without remounting the canvas.
  fireEvent.change(yaml, { target: { value: richYaml } });
  fireEvent.click(within(editor).getByRole("button", { name: "Validate" }));
  await waitFor(() => expect(within(editor).getByRole("button", { name: "Save preset" })).toBeEnabled());
  expect(within(editor).queryByText("Fix the input mappings flagged in the graph before saving.")).not.toBeInTheDocument();
});

const commentedYaml = richYaml.replace(
  "    depends_on:\n      - task-review",
  "    depends_on:\n      - task-review # synthesis gate",
);

it("preserves comments on surviving depends_on items when an edge is added", async () => {
  apiMock.validateSwarmPreset.mockResolvedValue({ valid: true, errors: [], warnings: [], layers: [] });
  const editor = await openVisualEditor(commentedYaml);

  fireEvent.click(nodeButton("task-summary", "Select"));
  fireEvent.click(nodeButton("task-summary", "Add dependency"));
  fireEvent.click(nodeButton("task-summary", "task-market"));

  const draft = await validatedYamlDraft(editor);
  expect(draft).toContain("task-review # synthesis gate");
  expect(draft).toContain("- task-market");
});

it("preserves comments on remaining depends_on items during task deletion cleanup", async () => {
  const cleanupYaml = commentedYaml.replace(
    "      - task-review # synthesis gate",
    "      - task-review # synthesis gate\n      - task-market # raw input",
  );
  apiMock.validateSwarmPreset.mockResolvedValue({ valid: true, errors: [], warnings: [], layers: [] });
  const editor = await openVisualEditor(cleanupYaml);

  fireEvent.click(nodeButton("task-review", "Remove task: task-review"));

  const draft = await validatedYamlDraft(editor);
  expect(draft).not.toContain("task-review");
  expect(draft).not.toContain("synthesis gate");
  expect(draft).toContain("task-market # raw input");
});

it("reads and writes agent limits as flat keys on the agent map", async () => {
  const limitedYaml = richYaml.replace(
    "  - id: analyst",
    "  - id: analyst\n    max_iterations: 5",
  );
  apiMock.validateSwarmPreset.mockResolvedValue({ valid: true, errors: [], warnings: [], layers: [] });
  const editor = await openVisualEditor(limitedYaml);

  fireEvent.click(nodeButton("task-market", "Select"));
  const iterations = within(editor).getByLabelText("Max iterations");
  expect(iterations).toHaveValue(5);
  fireEvent.change(iterations, { target: { value: "9" } });

  const draft = await validatedYamlDraft(editor);
  expect(draft).toContain("max_iterations: 9");
  expect(draft).not.toContain("limits:");
});

it("offers only mapping fixes when the referenced input task no longer exists", async () => {
  const missing = richYaml.replace("      market: task-market", "      market: task-ghost");
  apiMock.validateSwarmPreset.mockResolvedValue({ valid: true, errors: [], warnings: [], layers: [] });
  const editor = await openVisualEditor(missing);

  await within(editor).findByRole("alert");
  expect(within(editor).queryByRole("button", { name: "Re-link dependency" })).not.toBeInTheDocument();
  expect(within(editor).getByText("The referenced task no longer exists. Remap the input in the inspector or remove the mapping."));
});

it("falls back to the YAML editor with content untouched when fidelity cannot be guaranteed", async () => {
  const brokenYaml = "name: alpha_team\nagents: [unclosed\n";
  const editor = await openVisualEditor(brokenYaml);

  const alert = await within(editor).findByRole("alert");
  expect(alert).toHaveTextContent("Visual editing is unavailable for this document.");
  fireEvent.click(within(alert).getByRole("button", { name: "Use the YAML editor" }));

  const yaml = within(editor).getByRole("textbox", { name: "YAML source" });
  expect(yaml).toHaveValue(brokenYaml);
});

it("renders a cyclic graph without crashing and leaves rejection to validation", async () => {
  const cyclic = [
    "name: alpha_team",
    "agents:",
    "  - id: analyst",
    "    system_prompt: Loop.",
    "tasks:",
    "  - id: task-a",
    "    agent_id: analyst",
    "    depends_on:",
    "      - task-b",
    "  - id: task-b",
    "    agent_id: analyst",
    "    depends_on:",
    "      - task-a",
    "",
  ].join("\n");
  apiMock.validateSwarmPreset.mockResolvedValue({ valid: false, errors: ["Cycle detected"], warnings: [], layers: [] });
  const editor = await openVisualEditor(cyclic);

  expect(nodeOf("task-a")).toBeInTheDocument();
  expect(nodeOf("task-b")).toBeInTheDocument();
});

it("blocks the visual editor when agents carry duplicate ids", async () => {
  const duplicated = [
    "name: alpha_team",
    "agents:",
    "  - id: analyst",
    "    system_prompt: First.",
    "  - id: analyst",
    "    system_prompt: Second variant.",
    "tasks: []",
    "",
  ].join("\n");
  const editor = await openVisualEditor(duplicated);

  expect(await within(editor).findByRole("alert")).toHaveTextContent("Visual editing is unavailable for this document.");
  fireEvent.click(within(editor).getByRole("button", { name: "Use the YAML editor" }));
  expect(within(editor).getByRole("textbox", { name: "YAML source" })).toBeInTheDocument();
});

it("starts a new preset from a canvas-ready template", async () => {
  apiMock.listSwarmPresetCatalog.mockResolvedValue(makeCatalog());
  render(<SwarmTeams />);

  fireEvent.click(await screen.findByRole("button", { name: "New preset" }));
  const editor = await screen.findByRole("region", { name: "Preset YAML editor" });
  expect(within(editor).getByText("task-1")).toBeInTheDocument();

  fireEvent.click(within(editor).getByRole("button", { name: "YAML" }));
  const yaml = within(editor).getByRole("textbox", { name: "YAML source" }) as HTMLTextAreaElement;
  expect(yaml.value).toContain("name: new_preset");
});
