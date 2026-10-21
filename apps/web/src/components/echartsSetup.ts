/**
 * The part of ECharts the history charts use, and nothing else: named imports
 * so the build drops every other chart type. Loaded on first use by
 * HistoryChart, never in the app's main bundle.
 */
import { init, use } from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  MarkLineComponent,
  MarkPointComponent,
  ToolboxComponent,
  TooltipComponent,
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";

use([LineChart, GridComponent, TooltipComponent, DataZoomComponent, ToolboxComponent, MarkPointComponent, MarkLineComponent, SVGRenderer]);

export { init };
