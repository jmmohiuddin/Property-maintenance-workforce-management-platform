/**
 * `FLD-1`: *"My jobs - today and tomorrow, ordered by scheduled window, fully
 * readable offline. **The UI reads only from the local store, never from the
 * network.**"*
 *
 * The emphasised sentence is the design. There is no loading state on this
 * screen, no spinner and no error state, because there is no request. The query
 * below reads SQLite and returns; sync happens on its own schedule and its
 * result appears because the query is observable, not because this screen asked
 * for it.
 *
 * That is what makes the app usable in a basement, and it is also why the sync
 * banner exists: with no network in the read path, a broken sync is invisible
 * unless something says so.
 *
 * NOT RENDERED IN THIS SESSION - see the note at the top of App.tsx.
 */

import { useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { Database } from "@nozbe/watermelondb";
import { Q } from "@nozbe/watermelondb";

import { theme } from "../theme";
import type { Job } from "../../db/models";
import { PRIORITY_LABEL, STATUS_LABEL, type JobPriority, type JobStatus } from "@meridian/core";
import { AttendanceBar } from "../components/AttendanceBar";

export function JobListScreen({
  database,
  onOpenJob,
}: {
  database: Database;
  onOpenJob: (jobId: string) => void;
}): React.JSX.Element {
  const [jobs, setJobs] = useState<Job[] | null>(null);

  useEffect(() => {
    // Observable query: re-runs on every local write and on every sync, so the
    // list stays current without this screen knowing anything about either.
    const subscription = database
      .get<Job>("jobs")
      .query(Q.sortBy("scheduled_for", Q.asc))
      .observe()
      .subscribe(setJobs);
    return () => subscription.unsubscribe();
  }, [database]);

  // `null` means the query has not returned yet - microseconds, not a network
  // round trip. An empty array means the technician genuinely has no work,
  // which is a different sentence.
  //
  // `TECH-8`'s clock-in/out lives here, above every state below including the
  // empty one: a shift is clocked in and out on a day-level fact, not a
  // per-job one (`domain/shift-clock.ts`), and this screen is the one place
  // in the app not scoped to a single job - see the header this screen
  // already carries about being "My jobs", read first thing in a shift.
  if (jobs === null) {
    return (
      <View style={styles.screen}>
        <AttendanceBar database={database} />
      </View>
    );
  }

  if (jobs.length === 0) {
    return (
      <View style={styles.screen}>
        <AttendanceBar database={database} />
        <View style={styles.centred}>
          <Text style={styles.emptyTitle}>No jobs on this phone</Text>
          <Text style={styles.emptyBody}>
            Either you have nothing assigned, or this phone has not synced yet. Check the bar at the top -
            if it says the sync has failed, that is why.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <AttendanceBar database={database} />
      <FlatList
        style={styles.list}
        data={jobs}
        keyExtractor={(job) => job.id}
        renderItem={({ item }) => <JobRow job={item} onPress={() => onOpenJob(item.id)} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />
    </View>
  );
}

function JobRow({ job, onPress }: { job: Job; onPress: () => void }): React.JSX.Element {
  return (
    <Pressable onPress={onPress} style={styles.row} accessibilityRole="button">
      <View style={styles.rowHeader}>
        <Text style={styles.window}>{formatWindow(job.scheduledFor)}</Text>
        <Text style={[styles.priority, priorityStyle(job.priority as JobPriority)]}>
          {PRIORITY_LABEL[job.priority as JobPriority] ?? job.priority}
        </Text>
      </View>
      <Text style={styles.title} numberOfLines={2}>
        {job.title}
      </Text>
      <Text style={styles.reference}>
        {job.reference} · {STATUS_LABEL[job.status as JobStatus] ?? job.status}
      </Text>
    </Pressable>
  );
}

/**
 * A job with no scheduled time says so rather than showing a fabricated one.
 * The device clock is not trusted for anything, but a missing value is not a
 * clock problem - it is a job dispatch has not placed in the day yet, and the
 * technician needs to know that rather than see "00:00".
 */
function formatWindow(scheduledFor: number | undefined): string {
  if (scheduledFor === undefined) return "No time set";
  const date = new Date(scheduledFor);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function priorityStyle(priority: JobPriority) {
  switch (priority) {
    case "p1_emergency":
      return { color: theme.colour.danger };
    case "p2_urgent":
      return { color: theme.colour.warning };
    default:
      return { color: theme.colour.textMuted };
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colour.background },
  list: { flex: 1 },
  centred: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space.xl },
  emptyTitle: { color: theme.colour.text, fontSize: theme.font.title, marginBottom: theme.space.md },
  emptyBody: { color: theme.colour.textMuted, fontSize: theme.font.body, textAlign: "center", lineHeight: 24 },
  row: { padding: theme.space.md, minHeight: theme.touchTarget },
  rowHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: theme.space.xs },
  window: { color: theme.colour.text, fontSize: theme.font.title, fontVariant: ["tabular-nums"] },
  priority: { fontSize: theme.font.small, fontWeight: "700" },
  title: { color: theme.colour.text, fontSize: theme.font.body, marginBottom: theme.space.xs },
  reference: { color: theme.colour.textMuted, fontSize: theme.font.small },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colour.border },
});
