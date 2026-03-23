import type { Agent, AgentToolResult } from "@dg-forsonny/dg-pi-agent-core";
import type { AgentToolDetails } from "./agent.js";

export interface TrackedAgent {
	id: string;
	agentName: string;
	description?: string;
	agent: Agent;
	promise: Promise<AgentToolResult<AgentToolDetails>>;
	status: AgentToolDetails["status"] | "running";
	result?: AgentToolResult<AgentToolDetails>;
	startedAt: number;
	endedAt?: number;
}

const MAX_TRACKED_AGENTS = 50;

export class AgentTracker {
	private agents = new Map<string, TrackedAgent>();
	private idCounter = 0;
	private completionCallbacks = new Set<(id: string, tracked: TrackedAgent) => void>();

	/**
	 * Register a running agent. Returns a unique ID.
	 */
	register(
		agentName: string,
		agent: Agent,
		promise: Promise<AgentToolResult<AgentToolDetails>>,
		description?: string,
	): string {
		// Evict oldest completed agents if at capacity
		if (this.agents.size >= MAX_TRACKED_AGENTS) {
			this.evictOldest();
		}

		const id = `agent-${++this.idCounter}`;
		const tracked: TrackedAgent = {
			id,
			agentName,
			description,
			agent,
			promise,
			status: "running",
			startedAt: Date.now(),
		};

		this.agents.set(id, tracked);

		// Attach completion handler
		promise.then(
			(result) => {
				tracked.result = result;
				tracked.status = result.details.status;
				tracked.endedAt = Date.now();
				for (const cb of this.completionCallbacks) {
					cb(id, tracked);
				}
			},
			() => {
				tracked.status = "error";
				tracked.endedAt = Date.now();
				for (const cb of this.completionCallbacks) {
					cb(id, tracked);
				}
			},
		);

		return id;
	}

	/**
	 * Get a tracked agent by ID.
	 */
	get(id: string): TrackedAgent | undefined {
		return this.agents.get(id);
	}

	/**
	 * Get the raw Agent instance for continuation (Feature 3).
	 */
	getAgent(id: string): Agent | undefined {
		return this.agents.get(id)?.agent;
	}

	/**
	 * Get all tracked agents.
	 */
	getAll(): TrackedAgent[] {
		return Array.from(this.agents.values());
	}

	/**
	 * Register a callback for when any agent completes.
	 * Returns an unsubscribe function.
	 */
	onCompletion(callback: (id: string, tracked: TrackedAgent) => void): () => void {
		this.completionCallbacks.add(callback);
		return () => this.completionCallbacks.delete(callback);
	}

	/**
	 * Evict the oldest completed agent to make room.
	 */
	private evictOldest(): void {
		let oldestId: string | undefined;
		let oldestTime = Infinity;
		for (const [id, tracked] of this.agents) {
			if (tracked.status !== "running" && tracked.startedAt < oldestTime) {
				oldestTime = tracked.startedAt;
				oldestId = id;
			}
		}
		if (oldestId) {
			this.agents.delete(oldestId);
		}
	}

	/**
	 * Clean up all tracked agents.
	 */
	dispose(): void {
		for (const tracked of this.agents.values()) {
			if (tracked.status === "running") {
				tracked.agent.abort();
			}
		}
		this.agents.clear();
		this.completionCallbacks.clear();
	}
}
