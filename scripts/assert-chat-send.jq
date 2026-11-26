# Gateway CLI failures can arrive as JSON on stdout. Keep free-form messages,
# connection details and transcripts out of hosted logs.
if length != 1 then
  error("chat.send " + $expected + ": expected one response, received " + (length | tostring))
elif (.[0] | type) != "object" then
  error("chat.send " + $expected + ": unexpected response type " + (.[0] | type))
else
  .[0] |
  if .runId == $expected and .ok != false then true
  else
    ((.error | objects) // {}) as $err |
    (($err.details | objects) // {}) as $details |
    {
      expectedRunId: $expected, runId, status,
      errorType: $err.type, errorCode: $err.code, transportKind: $err.kind,
      reason: $details.reason, retryable: $err.retryable, retryAfterMs: $err.retryAfterMs
    } |
    with_entries(.value |= (
      if type == "string" then
        if test("^[A-Za-z0-9_-]{1,128}$") then . else "<omitted>" end
      elif type == "array" or type == "object" then "<omitted>"
      else . end
    )) |
    error("chat.send: " + tojson)
  end
end
