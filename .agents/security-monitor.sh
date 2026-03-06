#!/bin/bash
# Security Monitor Script - v1.0.0
# Last Updated: 05/03/2026
# Monitors security review sub-agents every 30 seconds

WORKSPACE_ID="07BD972E-C22C-4ACB-9B4D-AF65B0CAA71A"
SURFACES=("surface:4" "surface:5" "surface:6" "surface:7")
AGENT_NAMES=("Secrets Scanner" "Dependency Auditor" "Auth Reviewer" "Injection Tester")

log_message() {
    cmux log --level info --source "security-monitor" --workspace "$WORKSPACE_ID" "$1"
}

check_agent_status() {
    local surface=$1
    local agent_name=$2
    local output
    output=$(cmux read-screen --workspace "$WORKSPACE_ID" --surface "$surface" --lines 5 2>/dev/null)
    
    if echo "$output" | grep -q "opencode"; then
        log_message "✅ $agent_name is active on $surface"
        return 0
    else
        log_message "⚠️  $agent_name may be idle on $surface"
        return 1
    fi
}

# Initial notification
cmux notify --workspace "$WORKSPACE_ID" --title "Security Monitor" --body "Started monitoring 4 security agents - checking every 30 seconds"

log_message "Security monitor started - monitoring 4 agents"

# Monitor loop
counter=0
while true; do
    sleep 30
    counter=$((counter + 1))
    
    log_message "=== Check-in #$counter ==="
    
    active_count=0
    for i in "${!SURFACES[@]}"; do
        if check_agent_status "${SURFACES[$i]}" "${AGENT_NAMES[$i]}"; then
            ((active_count++))
        fi
    done
    
    # Update progress based on active agents
    progress=$(echo "scale=2; $active_count / 4" | bc)
    cmux set-progress --workspace "$WORKSPACE_ID" "$progress" --label "$active_count/4 agents active - Check-in #$counter"
    
    # Send summary notification every 2 minutes (4 check-ins)
    if [ $((counter % 4)) -eq 0 ]; then
        cmux notify --workspace "$WORKSPACE_ID" --title "Security Review Status" --body "$active_count/4 agents active after $((counter * 30 / 60)) minutes"
    fi
done
