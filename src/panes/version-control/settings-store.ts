import { create } from 'zustand'

interface VCSettingsState {
  confirmDiscard: boolean
  setConfirmDiscard: (v: boolean) => void
  toggleConfirmDiscard: () => void
}

export const useVCSettings = create<VCSettingsState>((set) => ({
  confirmDiscard: true,
  setConfirmDiscard: (confirmDiscard) => set({ confirmDiscard }),
  toggleConfirmDiscard: () => set((s) => ({ confirmDiscard: !s.confirmDiscard })),
}))
