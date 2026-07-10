// tests/db_test.ts
Deno.env.set("KV_PATH", ":memory:");

import { assertEquals, assertNotEquals } from "https://deno.land/std@0.200.0/assert/mod.ts";
import { createSession, checkSession, deleteSession, kv, pk } from "../src/db.ts";

Deno.test("Session Lifecycle: create, check, delete, and expiration", async (t) => {
  // Test 1: Verify createSession() creates an active session and returns a future expiration timestamp.
  await t.step("createSession() stores session and returns future expiration timestamp", async () => {
    const sessionId = crypto.randomUUID();
    const username = "testuser";
    const expires = await createSession(sessionId, username);
    
    assertNotEquals(expires, null);
    assertEquals(expires > Date.now(), true);
    
    // Check that it exists in KV under prefixed sessions key
    const res = await kv.get<{ username: string; expires: number }>(pk("sessions", sessionId));
    assertNotEquals(res.value, null);
    assertEquals(res.value?.username, username);
    assertEquals(res.value?.expires, expires);
  });

  // Test 2: Verify that checkSession() returns the correct username for a valid session.
  await t.step("checkSession() returns username for valid session", async () => {
    const sessionId = crypto.randomUUID();
    const username = "alice";
    await createSession(sessionId, username);
    
    const retrieved = await checkSession(sessionId);
    assertEquals(retrieved, username);
  });

  // Test 3: Verify that checkSession() returns null and wipes the session from Deno KV if the session is expired.
  await t.step("checkSession() returns null and deletes session if expired", async () => {
    const sessionId = crypto.randomUUID();
    const username = "bob";
    // Write an already expired session directly to KV
    const expiredTime = Date.now() - 1000;
    await kv.set(pk("sessions", sessionId), { username, expires: expiredTime });
    
    const retrieved = await checkSession(sessionId);
    assertEquals(retrieved, null);
    
    // Verify it is completely wiped from KV
    const res = await kv.get(pk("sessions", sessionId));
    assertEquals(res.value, null);
  });

  // Test 4: Verify that deleteSession() successfully removes the session key from KV.
  await t.step("deleteSession() removes the session from KV", async () => {
    const sessionId = crypto.randomUUID();
    const username = "charlie";
    await createSession(sessionId, username);
    
    // Delete session
    await deleteSession(sessionId);
    
    const retrieved = await checkSession(sessionId);
    assertEquals(retrieved, null);
    
    const res = await kv.get(pk("sessions", sessionId));
    assertEquals(res.value, null);
  });
});
