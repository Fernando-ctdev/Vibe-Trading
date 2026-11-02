import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import i18n from "@/i18n";
import { SwarmTeams } from "../SwarmTeams";

const apiMock = vi.hoisted(() => ({
  listSwarmPresetCatalog: vi.fn(),
  getSwarmPresetSource: vi.fn(),
  validateSwarmPreset: vi.fn(),
  createSwarmPreset: vi.fn(),
  saveSwarmPresetSource: vi.fn(),
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
