# Discovery and retained tool history can change how many HTTP requests carry the same call.
if .schemaVersion != 2 or .scenario != $scenario or .provider != "aimock" then
  error("unexpected AIMock evidence source")
elif (.strictMissCount == 0 and .requestCount > 0 and
      .successfulFixtureResponseCount == .requestCount and .promptRequestCount > 0) | not then
  error("expected matched, successful requests with the fixture prompt")
elif any(.tools[]; (.resultRequestCount // 0) < 1) then
  error("missing native tool result")
else
  {scenario, model, finalResponseCount, tools: ([.tools[] | {name, callResponseCount}] | sort_by(.name))} as $actual |
  ($expected[0] | .tools |= sort_by(.name)) as $want |
  if $actual == $want then true else error("AIMock outcome mismatch: expected \($want), observed \($actual)") end
end
