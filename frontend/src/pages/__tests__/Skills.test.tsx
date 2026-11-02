import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import i18n from "@/i18n";
import { ApiError } from "@/lib/api";
import { Skills } from "../Skills";

const apiMock = vi.hoisted(() => ({
  listSkillCatalog: vi.fn(),
  getSkillSource: vi.fn(),
  createSkill: vi.fn(),
  saveSkillSource: vi.fn(),
  deleteSkillSource: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, api: apiMock };
});

// The page's translation keys land in Lume's 11 locales; registering the
// approved English fallbacks keeps these tests deterministic until then.
const ENGLISH_KEYS: Record<string, string> = {
  "skills.badge": "Skills",
  "skills.title": "Skills",
  "skills.subtitle": "Browse bundled and user skills. Bundled skills are read-only; create, edit, and delete your own.",
  "skills.loading": "Loading skill catalog…",
  "skills.loadingSource": "Loading skill…",
  "skills.unavailable": "Skill catalog unavailable",
  "skills.retry": "Retry",
  "skills.emptyCatalog": "No skills found.",
  "skills.source.user": "User",
  "skills.source.bundled": "Bundled",
  "skills.readOnly": "Read-only",
  "skills.open": "Open",
  "skills.newSkill": "New skill",
  "skills.creatingTitle": "New user skill",
  "skills.contentLabel": "SKILL.md content",
  "skills.create": "Create skill",
  "skills.edit": "Edit",
  "skills.save": "Save",
  "skills.delete": "Delete",
  "skills.cancel": "Cancel",
  "skills.close": "Close",
  "skills.created": "Skill created.",
  "skills.saved": "Skill saved.",
  "skills.deleted": "Skill deleted.",
  "skills.actionFailed": "The action failed.",
  "skills.error.nameCollision": "A bundled or user skill already declares this name. Choose a different name.",
  "skills.error.revisionStale": "This skill changed on the server. Your draft is preserved.",
  "skills.error.auxiliaryFiles": "Deletion was refused because the skill directory contains supporting files.",
  "skills.discardDraftReload": "Discard draft and load latest",
  "skills.dismiss": "Dismiss",
  "skills.viewingTitle": "Viewing {{name}}",
  "skills.editingTitle": "Editing {{name}}",
};

function makeCatalog() {
  return [
    { name: "alpha-zoo", source: "bundled", description: "Alpha factor zoo reference." },
    { name: "my_strategy", source: "user", description: "My own strategy notes." },
  ];
}

const bundledSource = {
  name: "alpha-zoo",
  source: "bundled",
  content: "---\nname: alpha-zoo\ndescription: Alpha factor zoo reference.\n---\n# Bundled body\n",
  revision: "rev-bundled",
};

const userSource = {
  name: "my_strategy",
  source: "user",
  content: "---\nname: my_strategy\ndescription: My own strategy notes.\n---\n# User body\n",
  revision: "rev-user-1",
};

beforeEach(() => {
  apiMock.listSkillCatalog.mockReset();
  apiMock.getSkillSource.mockReset();
  apiMock.createSkill.mockReset();
  apiMock.saveSkillSource.mockReset();
  apiMock.deleteSkillSource.mockReset();
  for (const [key, value] of Object.entries(ENGLISH_KEYS)) {
    i18n.addResource("en", "translation", key, value);
  }
});

beforeAll(async () => { await i18n.changeLanguage("en"); });

it("shows loading, empty, and recoverable error states for the catalog", async () => {
  let resolveCatalog!: (catalog: never[]) => void;
  apiMock.listSkillCatalog.mockReturnValue(new Promise((resolve) => { resolveCatalog = resolve; }));
  render(<Skills />);
  expect(screen.getByRole("status", { name: "Loading skill catalog…" })).toBeInTheDocument();

  resolveCatalog([]);
  expect(await screen.findByText("No skills found.")).toBeInTheDocument();

  apiMock.listSkillCatalog.mockRejectedValueOnce(new Error("Catalog offline"));
  const { rerender } = render(<Skills key="retry" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Catalog offline");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(apiMock.listSkillCatalog).toHaveBeenCalledTimes(3));
});

it("lists skills with sources, opens a bundled skill read-only with exact bytes", async () => {
  apiMock.listSkillCatalog.mockResolvedValue(makeCatalog());
  apiMock.getSkillSource.mockResolvedValue(bundledSource);
  render(<Skills />);

  expect(await screen.findByText("my_strategy")).toBeInTheDocument();
  expect(screen.getByText("Alpha factor zoo reference.")).toBeInTheDocument();
  expect(screen.getByText("User", { selector: "span" })).toBeInTheDocument();

  const card = screen.getByText("alpha-zoo").closest("article")!;
  fireEvent.click(within(card).getByRole("button", { name: "Open" }));

  const panel = await screen.findByRole("region", { name: "Viewing alpha-zoo" });
  const content = within(panel).getByLabelText("SKILL.md content");
  await waitFor(() => expect(content).toHaveValue(bundledSource.content));
  expect(content).toHaveAttribute("readonly");
  expect(within(panel).getByText("Bundled")).toBeInTheDocument();
  expect(within(panel).getByText("Read-only")).toBeInTheDocument();
  expect(within(panel).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  expect(within(panel).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  expect(apiMock.getSkillSource).toHaveBeenCalledWith("alpha-zoo");
});

it("edits a user skill and saves with the retrieved revision, then refreshes it", async () => {
  const edited = `${userSource.content}# appended note\n`;
  apiMock.listSkillCatalog.mockResolvedValue(makeCatalog());
  apiMock.getSkillSource
    .mockResolvedValueOnce(userSource)
    // The post-save refresh returns the server's exact saved bytes.
    .mockResolvedValueOnce({ ...userSource, content: edited, revision: "rev-user-2" });
  apiMock.saveSkillSource.mockResolvedValue({ name: "my_strategy", source: "user" });
  render(<Skills />);

  const card = (await screen.findByText("my_strategy")).closest("article")!;
  fireEvent.click(within(card).getByRole("button", { name: "Open" }));

  const panel = await screen.findByRole("region", { name: "Viewing my_strategy" });
  fireEvent.click(within(panel).getByRole("button", { name: "Edit" }));

  const editor = screen.getByRole("region", { name: "Editing my_strategy" });
  const content = within(editor).getByLabelText("SKILL.md content");
  fireEvent.change(content, { target: { value: edited } });


  fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(apiMock.saveSkillSource).toHaveBeenCalledWith("my_strategy", edited, "rev-user-1"),
  );

  expect(await screen.findByText("Skill saved.")).toBeInTheDocument();
  await waitFor(() => expect(apiMock.getSkillSource).toHaveBeenLastCalledWith("my_strategy"));
  const refreshed = await screen.findByRole("region", { name: "Viewing my_strategy" });
  expect(within(refreshed).getByLabelText("SKILL.md content")).toHaveValue(edited);
  await waitFor(() => expect(apiMock.listSkillCatalog).toHaveBeenCalledTimes(2));
});

it("reports name collisions when creating a skill and reloads the catalog after success", async () => {
  apiMock.listSkillCatalog.mockResolvedValue(makeCatalog());
  apiMock.createSkill
    .mockRejectedValueOnce(new ApiError("A bundled skill already declares the name 'my_strategy'", 409, "name_collision"))
    .mockResolvedValueOnce({ name: "fresh_skill", source: "user" });
  render(<Skills />);

  fireEvent.click(await screen.findByRole("button", { name: "New skill" }));
  const creator = screen.getByRole("region", { name: "New user skill" });
  const content = within(creator).getByLabelText("SKILL.md content");
  // jest-dom's toHaveValue does not accept regex; assert on the raw value.
  expect((content as HTMLTextAreaElement).value).toContain("name: my_skill");

  fireEvent.click(within(creator).getByRole("button", { name: "Create skill" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "A bundled or user skill already declares this name. Choose a different name.",
  );
  expect(within(creator).getByLabelText("SKILL.md content")).toBeInTheDocument();

  const fresh = (content as HTMLTextAreaElement).value.replace("my_skill", "fresh_skill");
  fireEvent.change(content, { target: { value: fresh } });
  fireEvent.click(within(creator).getByRole("button", { name: "Create skill" }));

  await waitFor(() => expect(apiMock.createSkill).toHaveBeenLastCalledWith(fresh));
  expect(await screen.findByText("Skill created.")).toBeInTheDocument();
  await waitFor(() => expect(apiMock.listSkillCatalog).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("region", { name: "New user skill" })).not.toBeInTheDocument();
});

it("keeps the draft and offers a reload when a save hits revision_stale", async () => {
  apiMock.listSkillCatalog.mockResolvedValue(makeCatalog());
  apiMock.getSkillSource.mockResolvedValue(userSource);
  apiMock.saveSkillSource.mockRejectedValue(
    new ApiError("If-Match revision is stale", 409, "revision_stale"),
  );
  render(<Skills />);

  const card = (await screen.findByText("my_strategy")).closest("article")!;
  fireEvent.click(within(card).getByRole("button", { name: "Open" }));
  const editor = await screen.findByRole("region", { name: "Viewing my_strategy" });
  fireEvent.click(within(editor).getByRole("button", { name: "Edit" }));

  const editing = screen.getByRole("region", { name: "Editing my_strategy" });
  const content = within(editing).getByLabelText("SKILL.md content");
  fireEvent.change(content, { target: { value: `${userSource.content}# conflicting edit\n` } });
  fireEvent.click(within(editing).getByRole("button", { name: "Save" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("This skill changed on the server. Your draft is preserved.");
  expect(content).toHaveValue(`${userSource.content}# conflicting edit\n`);
  expect(apiMock.getSkillSource).toHaveBeenCalledTimes(1);

  fireEvent.click(within(alert).getByRole("button", { name: "Discard draft and load latest" }));
  await waitFor(() => expect(apiMock.getSkillSource).toHaveBeenCalledTimes(2));
  const reloaded = await screen.findByRole("region", { name: "Viewing my_strategy" });
  expect(within(reloaded).getByLabelText("SKILL.md content")).toHaveValue(userSource.content);
});

it("deletes a user skill with its revision and explains auxiliary-file refusals", async () => {
  apiMock.listSkillCatalog.mockResolvedValue(makeCatalog());
  apiMock.getSkillSource.mockResolvedValue(userSource);
  apiMock.deleteSkillSource
    .mockRejectedValueOnce(
      new ApiError(
        "Skill directory contains supporting files that would be lost: examples.md",
        409,
        "auxiliary_files_present",
      ),
    )
    .mockResolvedValueOnce({ name: "my_strategy", deleted: true });
  render(<Skills />);

  const card = (await screen.findByText("my_strategy")).closest("article")!;
  fireEvent.click(within(card).getByRole("button", { name: "Open" }));
  const panel = await screen.findByRole("region", { name: "Viewing my_strategy" });

  fireEvent.click(within(panel).getByRole("button", { name: "Delete" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    "Deletion was refused because the skill directory contains supporting files.",
  );
  expect(apiMock.deleteSkillSource).toHaveBeenCalledWith("my_strategy", "rev-user-1");
  expect(within(panel).getByLabelText("SKILL.md content")).toBeInTheDocument();

  fireEvent.click(within(panel).getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(apiMock.deleteSkillSource).toHaveBeenLastCalledWith("my_strategy", "rev-user-1"),
  );
  expect(await screen.findByText("Skill deleted.")).toBeInTheDocument();
  await waitFor(() => expect(apiMock.listSkillCatalog).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("region", { name: /my_strategy/ })).not.toBeInTheDocument();
});

it("surfaces backend validation messages for invalid skill documents", async () => {
  apiMock.listSkillCatalog.mockResolvedValue(makeCatalog());
  apiMock.createSkill.mockRejectedValue(
    new ApiError("Skill content must declare a non-empty frontmatter 'name'", 422, "invalid_skill"),
  );
  render(<Skills />);

  fireEvent.click(await screen.findByRole("button", { name: "New skill" }));
  const creator = screen.getByRole("region", { name: "New user skill" });
  fireEvent.change(within(creator).getByLabelText("SKILL.md content"), { target: { value: "no frontmatter\n" } });
  fireEvent.click(within(creator).getByRole("button", { name: "Create skill" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Skill content must declare a non-empty frontmatter 'name'",
  );
  expect(apiMock.listSkillCatalog).toHaveBeenCalledTimes(1);
});
