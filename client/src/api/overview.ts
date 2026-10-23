import { useQuery } from "@tanstack/react-query";
import type { FirmOverview } from "@shared/api";
import { api } from "./http";

export const overviewKeys = { all: ["api", "firm", "overview"] as const };

export function useFirmOverview() {
  return useQuery({ queryKey: overviewKeys.all, queryFn: () => api<FirmOverview>("GET", "/api/firm/overview") });
}
