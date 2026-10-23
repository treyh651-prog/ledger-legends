import { useQuery } from "@tanstack/react-query";
import type { Me } from "@shared/api";
import { api } from "./http";

export const meKeys = { me: ["api", "auth", "me"] as const };

export function useMe() {
  return useQuery({ queryKey: meKeys.me, queryFn: () => api<Me>("GET", "/api/auth/me") });
}
