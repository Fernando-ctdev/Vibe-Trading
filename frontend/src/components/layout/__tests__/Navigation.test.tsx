import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import { router } from "@/router";
import { SidebarNavigation } from "../SidebarNavigation";
import { PageHelp } from "../PageHelp";

beforeAll(async () => { await i18n.changeLanguage("en"); });

function renderNavigation(path = "/", collapsed = false) {
  return render(<MemoryRouter initialEntries={[path]}><SidebarNavigation collapsed={collapsed} /><PageHelp /></MemoryRouter>);
}

it("keeps every feature directly reachable and distinguishes tasks from tools and setup", () => {
  renderNavigation();
  expect(within(screen.getByRole("region", { name: "Everyday research" })).getAllByRole("link").map((link) => link.getAttribute("href")))
    .toEqual(["/", "/reports", "/paper-trading", "/portfolio"]);
  expect(screen.queryByRole("region", { name: "Specialized analysis" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Asset correlation" })).not.toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Automation & setup" })).getAllByRole("link").map((link) => link.getAttribute("href")))
    .toEqual(["/scheduled", "/swarm/teams", "/settings"]);
  expect(screen.getByRole("link", { name: "Research assistant" })).toHaveAttribute("aria-current", "page");
  expect(router.routes[0].children?.some((route) => route.path === "/correlation")).toBe(true);
});

it("keeps Correlation hidden from the compact menu while its route remains available", () => {
  renderNavigation("/correlation", true);
  expect(screen.queryByRole("link", { name: "Asset correlation" })).not.toBeInTheDocument();
  expect(screen.getByRole("navigation").querySelectorAll('[aria-current="page"]')).toHaveLength(0);
});

it("explains the backtest prerequisite and the separate location of chat-generated documents", () => {
  renderNavigation("/reports");
  fireEvent.click(screen.getByText("How to use Backtest reports"));
  expect(screen.getByText(/Download PDFs and other chat-generated documents/)).toBeVisible();
  expect(screen.getByRole("link", { name: "Start with the research assistant" })).toHaveAttribute("href", "/");
});

it("resets page help on navigation and states the scheduler prerequisite", () => {
  renderNavigation("/reports");
  fireEvent.click(screen.getByText("How to use Backtest reports"));
  fireEvent.click(screen.getByRole("link", { name: "Scheduled research" }));
  const summary = screen.getByText("How to use Scheduled research");
  expect(summary.closest("details")).not.toHaveAttribute("open");
  fireEvent.click(summary);
  expect(screen.getByText(/local scheduler must be enabled/)).toBeVisible();
});

it("opens a labeled feature menu in compact mode and returns focus on Escape", () => {
  renderNavigation("/", true);
  const trigger = screen.getByRole("button", { name: "Browse features" });
  fireEvent.click(trigger);
  const menu = screen.getByRole("navigation", { name: "Browse features" });
  expect(within(menu).queryByText("Options analysis")).not.toBeInTheDocument();
  expect(within(menu).queryByText("Pixel Office")).not.toBeInTheDocument();
  expect(within(menu).queryByText("Trading status")).not.toBeInTheDocument();
  expect(within(menu).queryByText("Asset correlation")).not.toBeInTheDocument();
  expect(within(menu).getByRole("link", { name: "Swarm teams" })).toHaveAttribute("href", "/swarm/teams");
  expect(within(menu).getAllByRole("link")).toHaveLength(7);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("navigation", { name: "Browse features" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("closes the feature menu after selecting a destination", () => {
  renderNavigation("/", true);
  fireEvent.click(screen.getByRole("button", { name: "Browse features" }));
  const menu = screen.getByRole("navigation", { name: "Browse features" });
  fireEvent.click(within(menu).getByRole("link", { name: "Backtest reports" }));
  expect(screen.queryByRole("navigation", { name: "Browse features" })).not.toBeInTheDocument();
  expect(screen.getByText("How to use Backtest reports")).toBeInTheDocument();
});


it("links paper accounts and explains completed-session simulation", () => {
  renderNavigation("/paper-trading");
  expect(screen.getByRole("link", { name: "Paper trading" })).toHaveAttribute("aria-current", "page");
  fireEvent.click(screen.getByText("How to use Paper trading"));
  expect(screen.getByText(/No broker orders are sent/)).toBeVisible();
  expect(screen.getByText(/Only completed daily bars can settle/)).toBeVisible();
});
