import { afterEach, describe, expect, it, vi } from "vitest";
import { formatLocalMoney, localCurrency, usdToLocalRate } from "./local-currency";

describe("local currency", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps explicit regions to their currency", () => {
    expect(new Intl.Locale("en-IN").maximize().region).toBe("IN");
    expect(new Intl.Locale("en-GB").maximize().region).toBe("GB");
    expect(new Intl.Locale("en-CA").maximize().region).toBe("CA");
  });

  it("falls back to USD for unmapped regions", () => {
    const info = localCurrency();
    expect(typeof info.locale).toBe("string");
    expect(info.currency.length).toBe(3);
    expect(info.currency).toBe(info.currency.toUpperCase());
  });

  it("formats local money with the given rate", () => {
    const info = { locale: "en-IN", currency: "INR" };
    expect(formatLocalMoney(100, info, 83.5)).toMatch(/8,350/);
  });

  it("returns null rates for USD and unknown currencies without network access", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: "success", rates: { INR: 83.5 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(usdToLocalRate("USD")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(usdToLocalRate("NOPE_BAD")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
