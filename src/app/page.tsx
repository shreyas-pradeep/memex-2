import "@xyflow/react/dist/style.css";
import { MemexCanvas } from "@/components/canvas/MemexCanvas";

export default function Home() {
  return (
    <main style={{ width: "100vw", height: "100vh", overflow: "hidden" }}>
      <MemexCanvas />
    </main>
  );
}
