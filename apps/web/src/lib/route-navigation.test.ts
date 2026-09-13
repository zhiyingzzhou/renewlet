import { describe, expect, it, vi } from "vitest";
import { createRouteNavigation } from "./route-navigation";

describe("route navigation lifecycle", () => {
  it("starts cold routes at commit and finishes only after a matching readiness report", () => {
    const navigation = createRouteNavigation();
    const location = { key: "initial", target: "/subscriptions" };
    navigation.commit(location);
    const id = navigation.getSnapshot().id;
    expect(navigation.getSnapshot()).toMatchObject({ phase: "loading", ...location });
    navigation.complete(id, { ...location, key: "stale" });
    expect(navigation.getSnapshot().phase).toBe("loading");
    navigation.complete(id, location);
    expect(navigation.getSnapshot().phase).toBe("complete");
  });

  it("does not let a previous visit to the same URL finish a new navigation", () => {
    const navigation = createRouteNavigation();
    const first = { key: "first", target: "/subscriptions" };
    navigation.commit(first);
    const firstId = navigation.getSnapshot().id;
    navigation.complete(firstId, first);
    navigation.begin("/calendar");
    navigation.commit({ key: "calendar", target: "/calendar" });
    navigation.begin("/subscriptions");
    const pending = navigation.getSnapshot();
    navigation.complete(firstId, first);
    expect(navigation.getSnapshot()).toBe(pending);
    const current = { key: "second", target: "/subscriptions" };
    navigation.commit(current);
    navigation.complete(firstId, first);
    expect(navigation.getSnapshot().phase).toBe("loading");
    navigation.complete(pending.id, current);
    expect(navigation.getSnapshot().phase).toBe("complete");
  });

  it("keeps the navigation identity when its module commits and ignores repeated intent", () => {
    const navigation = createRouteNavigation();
    navigation.begin("/settings");
    const initial = navigation.getSnapshot();
    navigation.begin("/settings");
    expect(navigation.getSnapshot()).toBe(initial);
    navigation.commit({ key: "settings", target: "/settings" });
    expect(navigation.getSnapshot().id).toBe(initial.id);
  });

  it("rejects a stale navigation ID even when history reuses the same location key", () => {
    const navigation = createRouteNavigation();
    const home = { key: "home", target: "/" };
    navigation.commit(home);
    const previousId = navigation.getSnapshot().id;
    navigation.complete(previousId, home);
    navigation.commit({ key: "settings", target: "/settings" });
    navigation.commit(home);
    navigation.complete(previousId, home);
    expect(navigation.getSnapshot().phase).toBe("loading");
    navigation.complete(navigation.getSnapshot().id, home);
    expect(navigation.getSnapshot().phase).toBe("complete");
  });

  it("handles redirects and ignores stale completion after rapid navigation", () => {
    const navigation = createRouteNavigation();
    navigation.begin("/settings");
    navigation.commit({ key: "settings", target: "/settings" });
    navigation.commit({ key: "login", target: "/login?next=%2Fsettings" });
    navigation.complete(navigation.getSnapshot().id, { key: "settings", target: "/settings" });
    expect(navigation.getSnapshot()).toMatchObject({ phase: "loading", key: "login" });
  });

  it("does not restart on background readiness or hash-only location keys", () => {
    const navigation = createRouteNavigation();
    const location = { key: "settings", target: "/settings" };
    navigation.commit(location);
    navigation.complete(navigation.getSnapshot().id, location);
    const finished = navigation.getSnapshot();
    navigation.begin("/settings");
    navigation.commit({ ...location, key: "hash" });
    navigation.complete(finished.id, location);
    expect(navigation.getSnapshot()).toBe(finished);
  });

  it("cancels an uncommitted intent when returning to the current page", () => {
    const navigation = createRouteNavigation();
    navigation.commit({ key: "home", target: "/" });
    navigation.begin("/calendar");
    navigation.begin("/");
    expect(navigation.getSnapshot().phase).toBe("idle");
  });

  it("releases subscribers without affecting other application instances", () => {
    const first = createRouteNavigation();
    const second = createRouteNavigation();
    const listener = vi.fn();
    const unsubscribe = first.subscribe(listener);
    first.begin("/settings");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    first.begin("/calendar");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(second.getSnapshot().phase).toBe("idle");
  });
});
