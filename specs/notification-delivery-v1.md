# Notification delivery extension v1

Authenticated current backend owners may send `push_notification_request` with optional `requestId`.
A correlated `push_notification_result` returns version 1 and accepted/filtered/retryable/terminal.
Accepted means upstream HTTP acceptance, never device delivery. Gateway stores no application outbox;
legacy requests without IDs continue to work. Requests are bounded and validated before I/O.

Mobile devices query `/api/notifications/subscription/:backendId`; authorization uses the same
namespace/backend ACL as discovery. The DTO contains version, enabled, transportBasePath, topic,
and authMode, never ntfy publishing or subscription secrets. The device presents its own Gateway
credential to `/api/notifications/stream/:backendId/{json,sse}`. Gateway authenticates and forwards
ntfy's stream with read credentials. It revalidates authorization before every streamed chunk and
aborts on credential revocation/scope changes/shutdown. This is ephemeral transport, not a feed.
Existing `/config` stops returning secrets to devices; backend management compatibility is retained.

Tests: upstream success/non-2xx/network/disabled/filter; scoped subscription without secret fields;
unauthenticated and cross-backend denial; stream cancellation after revoke; legacy request compatibility.

Authenticated device UI may POST `/api/notifications/test/:backendId`. The same backend ACL as subscription applies (unknown and out-of-scope return 404). It publishes a short-lived versioned `kind: test` envelope with an opaque generated ID, without storing a business notification. Its response reports the delivery receipt; accepted means upstream accepted, not device displayed.

The legacy test endpoint also enforces backend ACL when a backend is provided; device credentials cannot publish an unscoped diagnostic.
