import { test } from "node:test";
import assert from "node:assert/strict";
import { isPracticumApi, handlePracticumApi } from "../practicum-api.js";

test("practicum API exposes only documented methods", () => {
  assert.equal(isPracticumApi("/api/practicum/me", "GET"), true);
  assert.equal(isPracticumApi("/api/practicum/portfolio", "POST"), true);
  assert.equal(isPracticumApi("/api/practicum/logbook", "GET"), true);
  assert.equal(isPracticumApi("/api/practicum/logbook/delete", "POST"), true);
  assert.equal(isPracticumApi("/api/practicum/logbook/delete", "GET"), false);
  assert.equal(isPracticumApi("/api/practicum/unknown", "POST"), false);
});

test("practicum APIs require a signed-in, verified @lru.ac.th identity", async () => {
  const env = {};
  const request = new Request("https://classroom.sorasukt.com/api/practicum/me");
  const noSession = await handlePracticumApi(request, env, { authorize: async () => false });
  assert.equal(noSession.status, 401);

  const otherDomain = await handlePracticumApi(request, env, { authorize: async () => ({
    sub: "user-1", email: "student@example.com", emailVerified: true
  }) });
  assert.equal(otherDomain.status, 403);

  const unverified = await handlePracticumApi(request, env, { authorize: async () => ({
    sub: "user-1", email: "student@lru.ac.th", emailVerified: false
  }) });
  assert.equal(unverified.status, 403);

  const verified = await handlePracticumApi(request, env, { authorize: async () => ({
    sub: "user-1", name: "Student", email: "student@lru.ac.th", emailVerified: true
  }) });
  assert.equal(verified.status, 200);
  assert.deepEqual(await verified.json(), {
    user: { name: "Student", email: "student@lru.ac.th" }, scope: "student"
  });
});
