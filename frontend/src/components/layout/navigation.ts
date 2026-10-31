import { FlaskConical, Bot, CalendarClock, FileText, Settings, Users, WalletCards } from "lucide-react";

export const NAVIGATION_GROUPS = [
  { id: "research", items: [
    { id: "agent", to: "/", icon: Bot },
    { id: "reports", to: "/reports", icon: FileText },
    { id: "paperTrading", to: "/paper-trading", icon: FlaskConical },
    { id: "portfolio", to: "/portfolio", icon: WalletCards },
  ] },
  { id: "automation", items: [
    { id: "scheduled", to: "/scheduled", icon: CalendarClock },
    { id: "swarmTeams", to: "/swarm/teams", icon: Users },
    { id: "settings", to: "/settings", icon: Settings },
  ] },
] as const;

export type NavigationItem = typeof NAVIGATION_GROUPS[number]["items"][number];

export function isNavigationActive(to: string, pathname: string): boolean {
  return to === "/" ? pathname === "/" || pathname === "/agent"
    : pathname === to || pathname.startsWith(`${to}/`);
}
