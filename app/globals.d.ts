declare module "*.css";

declare namespace JSX {
  interface IntrinsicElements {
    "s-app-nav": { children?: import("react").ReactNode };
  }
}
