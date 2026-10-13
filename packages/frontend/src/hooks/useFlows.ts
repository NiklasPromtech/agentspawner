import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import type { Flow, FlowInput } from '../types/index.js';

// ─── Query key factory ───────────────────────────────────────────────────────

const flowKeys = {
  all: (agentId: string) => ['flows', agentId] as const,
};

// ─── Fetch hook ──────────────────────────────────────────────────────────────

/** Fetch all flows for an agent with automatic background refresh. */
export function useFlows(agentId: string) {
  return useQuery<Flow[]>({
    queryKey: flowKeys.all(agentId),
    queryFn: () => api.getFlows(agentId),
  });
}

// ─── Mutation: create flow ───────────────────────────────────────────────────

export function useCreateFlow(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation<Flow, FlowInput>({
    mutationFn: (data) => api.createFlow(agentId, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: flowKeys.all(agentId) });
    },
  });
}

// ─── Mutation: update flow ───────────────────────────────────────────────────

export function useUpdateFlow(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation<Flow, { flowId: string; data: FlowInput }>({
    mutationFn: ({ flowId, data }) => api.updateFlow(agentId, flowId, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: flowKeys.all(agentId) });
    },
  });
}

// ─── Mutation: copy flow ─────────────────────────────────────────────────────

export function useCopyFlow(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation<Flow, string>({
    mutationFn: (flowId) => api.copyFlow(agentId, flowId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: flowKeys.all(agentId) });
    },
  });
}

// ─── Mutation: delete flow ───────────────────────────────────────────────────

export function useDeleteFlow(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ success: boolean }, string>({
    mutationFn: (flowId) => api.deleteFlow(agentId, flowId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: flowKeys.all(agentId) });
    },
  });
}

// ─── Mutation: pin / approve flow ────────────────────────────────────────────

export function usePinFlow(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation<Flow, { flowId: string; pinned: boolean }>({
    mutationFn: ({ flowId, pinned }) => api.pinFlow(agentId, flowId, pinned),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: flowKeys.all(agentId) });
    },
  });
}

// ─── Mutation: mark infeasible ───────────────────────────────────────────────

export function useMarkFlowInfeasible(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation<Flow, { flowId: string; infeasible: boolean; infeasibleReason?: string | null }>({
    mutationFn: ({ flowId, infeasible, infeasibleReason }) =>
      api.markFlowInfeasible(agentId, flowId, infeasible, infeasibleReason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: flowKeys.all(agentId) });
    },
  });
}
