import type { ColorValue } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);
const ThemedCircle = withUniwind(Circle);

export function SkaldMark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="Skald Code"
      height={props.height}
      width={props.height}
      viewBox="0 0 378 378"
    >
      <ThemedPath
        d="M293.13,109.10 A131.25,131.25 0 1 1 206.13,58.87"
        fill="none"
        stroke="currentColor"
        strokeWidth="37.5"
        strokeLinecap="round"
        color={props.color}
        colorClassName={props.colorClassName}
      />
      <ThemedCircle
        cx="189"
        cy="189"
        r="75"
        fill="currentColor"
        color={props.color}
        colorClassName={props.colorClassName}
      />
    </Svg>
  );
}
