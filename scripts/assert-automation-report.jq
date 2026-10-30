# compare every expected field on the same report; never print captured output.
def mismatches($expected):
  . as $report
  | [$expected | to_entries[] | . as $field
     | select(($report | getpath($field.key | split("."))) != $field.value)
     | .key];

def safe_value($pattern):
  if type == "string" then
    if length <= 120 and test($pattern) then . else "[unexpected value]" end
  else null end;

if any(.reports[]; mismatches($expected) | length == 0) then true
else error({
  expected: $expected,
  reportCount: (.reports | length),
  reports: [.reports[:5][] | {
    failedFields: mismatches($expected),
    status: (.status | safe_value("^(pending|delivered|failed|uncertain)$")),
    code: (.code | safe_value("^automation-[a-z-]+$")),
    reason: (.reason | safe_value("^(Exit [0-9]+|Timed out|Cancelled|Stopped by signal|Exit status unavailable)$")),
    messageIdPresent: (.messageId | type == "string")
  }]
} | tojson)
end
