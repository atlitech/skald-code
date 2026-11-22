import { gtFallback } from "gt-react-native";
import { expect, it, vi } from "vite-plus/test";

it("reuses the formatting locale across labels and respects a language switch", () => {
  using lookup = vi.spyOn(Intl.NumberFormat, "supportedLocalesOf");
  const time = new Date(2026, 0, 1, 15, 4);
  for (const locale of ["en-US", "fr-FR"]) {
    const options = { $locale: locale, time };
    const expected = new Intl.DateTimeFormat(locale, { hour: "numeric" }).format(time);
    expect(gtFallback("{time, time, ::j}", options)).toBe(expected);
    lookup.mockClear();
    expect(gtFallback("{count}m", { $locale: locale, count: 12 })).toBe("12m");
    expect(gtFallback("{time, time, ::j}", options)).toBe(expected);
    expect(lookup).not.toHaveBeenCalled();
  }
});
