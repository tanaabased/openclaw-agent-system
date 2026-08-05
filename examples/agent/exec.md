Run the exec tool exactly once with this exact command and do not retry:

if test "$AGENT_SYSTEM_LEIA_EXEC" = "$AGENT_SYSTEM_LEIA_SOURCE"
then
printf 'ENV_OK\n' > "$TMPDIR/agent-system-data-sentinel"
else
exit 1
fi

Then report the observed tool result.
