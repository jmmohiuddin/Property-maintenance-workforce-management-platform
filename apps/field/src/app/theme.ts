/**
 * Design constants for a phone held in a plant room.
 *
 * Two decisions worth stating. Touch targets are 56pt rather than the usual 44:
 * the user is wearing gloves and is often on a ladder. And the palette is high
 * contrast rather than subtle, because the screen is competing with direct sun
 * on a rooftop and with a torch in a basement - the two lighting conditions
 * this app is actually used in, and neither of them forgives grey-on-grey.
 */
export const theme = {
  colour: {
    background: "#0F1115",
    surface: "#1A1D23",
    surfaceRaised: "#242830",
    text: "#F5F7FA",
    textMuted: "#9AA4B2",
    border: "#333945",
    accent: "#3B82F6",
    success: "#16A34A",
    warning: "#D97706",
    danger: "#DC2626",
    /** Anything captured but not yet acknowledged by the server. */
    pending: "#7C3AED",
  },
  space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  radius: { sm: 6, md: 10, lg: 16 },
  touchTarget: 56,
  font: { small: 14, body: 17, title: 22, display: 28 },
} as const;
